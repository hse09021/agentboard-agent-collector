/**
 * `connect` asking for an access/refresh pair (#15, stage 3).
 *
 * The server and the collector upgrade on independent schedules, so a new
 * collector enrolling against an old server must store what it gets exactly as
 * before. What to store is decided by the reply's shape, never by a guess at
 * the server's version.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const API = "https://agentboard.acme.internal/api/proxy";

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(claims)}.signature`;
}

const ACCESS = jwt({ sub: "u1", prj: "ws_1", pair: true, iat: 1791000000, exp: 1791003600 });
const LEGACY = jwt({ sub: "u1", prj: "ws_1", iat: 1791000000, exp: 1798776000 });

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-enroll-v2-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("credentialFromEnrollment", () => {
  it("keeps a pair from a server that supports rotation", async () => {
    const { credentialFromEnrollment } = await import("../../src/cli/commands/connect");
    expect(
      credentialFromEnrollment({
        v: 2,
        access: ACCESS,
        access_expires_at: 1791003600,
        refresh: "opaque",
        refresh_expires_at: 1798776000,
        device_id: "dev_1",
        server: { api_base_url: API },
        project: { id: "p", display_name: "Billing" },
      })
    ).toEqual({
      v: 2,
      access: ACCESS,
      access_expires_at: 1791003600,
      refresh: "opaque",
      refresh_expires_at: 1798776000,
    });
  });

  it("reads the access expiry from the token when the reply omits it", async () => {
    const { credentialFromEnrollment } = await import("../../src/cli/commands/connect");
    expect(credentialFromEnrollment({ access: ACCESS, refresh: "opaque" })).toMatchObject({
      access_expires_at: 1791003600,
    });
  });

  // ★ 옛 서버는 모르는 키 `v`를 버리고 지금처럼 `credential` 하나를 준다.
  it("keeps an older server's single credential as before", async () => {
    const { credentialFromEnrollment } = await import("../../src/cli/commands/connect");
    expect(credentialFromEnrollment({ credential: `${LEGACY}\n`, device_id: "dev_1" })).toBe(LEGACY);
    // An access token with no refresh token is not a pair.
    expect(credentialFromEnrollment({ credential: LEGACY, access: ACCESS })).toBe(LEGACY);
  });

  it("finds nothing to store in an empty reply", async () => {
    const { credentialFromEnrollment } = await import("../../src/cli/commands/connect");
    expect(credentialFromEnrollment({})).toBeNull();
    expect(credentialFromEnrollment(null)).toBeNull();
    expect(credentialFromEnrollment({ access: ACCESS })).toBeNull();
  });

  it("stores either shape so the hooks read it back", async () => {
    const { credentialFromEnrollment } = await import("../../src/cli/commands/connect");
    const store = await import("../../src/platform/credential-store");
    // @ts-expect-error — plain ESM mirror without type declarations
    const hook = await import("../../plugin/hooks/lib/config.mjs");

    store.saveCredential("aaaa", credentialFromEnrollment({ access: ACCESS, refresh: "opaque" })!);
    store.saveCredential("bbbb", credentialFromEnrollment({ credential: LEGACY })!);

    expect(hook.loadProjectCredential("aaaa")).toMatchObject({ v: 2, access: ACCESS, refresh: "opaque" });
    expect(hook.loadRouteCredential("aaaa")).toBe(ACCESS);
    expect(fs.readFileSync(path.join(configDir, "credentials", "bbbb.cred"), "utf-8")).toBe(LEGACY);
    expect(hook.loadRouteCredential("bbbb")).toBe(LEGACY);
  });
});

describe("enrollDevice", () => {
  it("asks the server for a pair", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ credential: LEGACY }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { enrollDevice } = await import("../../src/cli/commands/connect");
    const { loadConfigV2 } = await import("../../src/core/bindings");

    await enrollDevice(API, "ticket", loadConfigV2());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/v1/collector/enroll`);
    expect(JSON.parse(String(init.body))).toMatchObject({ v: 2 });
  });
});
