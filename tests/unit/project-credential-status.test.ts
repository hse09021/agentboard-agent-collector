/**
 * What `status` and `doctor` say about connected projects' credentials.
 *
 * Hooks renew in the background, so these lines are the only place a user
 * learns that a connection expired or that the server refused to renew it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DAY = 24 * 60 * 60;
const NOW = Date.UTC(2026, 8, 13, 3, 0, 0);
const nowSec = Math.floor(NOW / 1000);
const DIR = "/work/billing-api";

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(claims)}.signature`;
}

function credential(daysLeft: number): string {
  const exp = nowSec + daysLeft * DAY;
  return jwt({ sub: "u1", iat: exp - 90 * DAY, exp });
}

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-project-status-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.stubEnv("AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS", "");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("describeProjectCredential / formatProjectCredential", () => {
  /** Its server answered an exchange the old way: it has no rotation yet. */
  const OLD_SERVER = { at: "2026-09-13T00:00:00Z", outcome: "legacy" as const };

  async function line(
    value: string | null,
    failure?: { at: string; status?: number; code?: string },
    upgrade?: { at: string; outcome: "legacy" | "refused" }
  ) {
    const m = await import("../../src/core/project-credential-status");
    return m.formatProjectCredential({ abs_dir: DIR }, m.describeProjectCredential(value, NOW), failure, upgrade);
  }

  it("says a healthy connection renews by itself", async () => {
    expect(await line(credential(60), undefined, OLD_SERVER)).toEqual({
      ok: true,
      message: "renews automatically (expires 2026-11-12)",
    });
    expect(await line(credential(10), undefined, OLD_SERVER)).toEqual({
      ok: true,
      message: "renews on the next upload (expires 2026-09-23)",
    });
  });

  it("says a legacy connection moves to rotation on the next upload until its server says it cannot", async () => {
    expect(await line(credential(60))).toEqual({
      ok: true,
      message: "switches to rotating credentials on the next upload (expires 2026-11-12)",
    });
  });

  it("tells the user to connect again once the credential expired", async () => {
    const result = await line(credential(-2));
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`expired on 2026-09-11 — run \`agentboard connect ${DIR}\` again`);
  });

  it("explains a refusal while the credential still works", async () => {
    const result = await line(credential(10), { at: "", status: 403, code: "not_a_member" });
    expect(result).toEqual({
      ok: false,
      message: "renewal refused (you are no longer a member of this organization); stops working on 2026-09-23",
    });

    const unknownCode = await line(credential(10), { at: "", status: 404, code: "" });
    expect(unknownCode.message).toContain("renewal refused (HTTP 404)");
  });

  // ★ 폐기된 기기는 업로드도 거절된다. 만료일까지 동작한다고 하면 거짓말이다.
  it("does not promise a revoked device days it no longer has", async () => {
    const result = await line(credential(10), { at: "", status: 403, code: "revoked_device" });
    expect(result).toEqual({
      ok: false,
      message: `this device was revoked on the server; uploads are blocked — run \`agentboard connect ${DIR}\` again`,
    });
  });

  it("reports a missing credential", async () => {
    expect((await line(null)).ok).toBe(false);
  });
});

describe("rotating connections", () => {
  function pair(refreshDaysLeft?: number) {
    return {
      v: 2,
      access: jwt({ sub: "u1", pair: true, iat: nowSec - 600, exp: nowSec + 3000 }),
      access_expires_at: nowSec + 3000,
      refresh: "opaque",
      ...(refreshDaysLeft !== undefined ? { refresh_expires_at: nowSec + refreshDaysLeft * DAY } : {}),
    };
  }

  async function line(
    value: ReturnType<typeof pair> | string,
    failure?: { at: string; status?: number; code?: string }
  ) {
    const m = await import("../../src/core/project-credential-status");
    return m.formatProjectCredential({ abs_dir: DIR }, m.describeProjectCredential(value, NOW), failure);
  }

  it("shows the refresh token's expiry", async () => {
    expect(await line(pair(80))).toEqual({ ok: true, message: "rotates automatically (refresh expires 2026-12-02)" });
    expect(await line(pair())).toEqual({ ok: true, message: "rotates automatically" });
    // Read from the file contents too.
    expect(await line(JSON.stringify(pair(80)))).toEqual({
      ok: true,
      message: "rotates automatically (refresh expires 2026-12-02)",
    });
  });

  it("says to connect again once the refresh token expired", async () => {
    expect(await line(pair(-1))).toEqual({
      ok: false,
      message: `expired on 2026-09-12 — run \`agentboard connect ${DIR}\` again`,
    });
  });

  // ★ access는 한 시간짜리다. refresh가 거절되면 "만료일까지 동작"이 아니라 이미 끊긴 것이다.
  it("says a refused refresh token has ended the connection", async () => {
    expect(await line(pair(80), { at: "", status: 401, code: "invalid_refresh" })).toEqual({
      ok: false,
      message:
        "the server stopped renewing this connection (the server no longer accepts this connection's refresh token)" +
        ` — run \`agentboard connect ${DIR}\` again`,
    });
    expect((await line(pair(80), { at: "", status: 404, code: "device_not_found" })).message).toContain(
      "the server no longer knows this device"
    );
    expect((await line(pair(80), { at: "", status: 403, code: "revoked_device" })).message).toContain(
      "this device was revoked on the server"
    );
  });

  it("says a rotation that could not be saved has stopped the connection, for pairs and legacy alike", async () => {
    const lost = { at: "", code: "save_failed" };
    for (const value of [pair(80), credential(60)]) {
      expect(await line(value, lost)).toEqual({
        ok: false,
        message: `a renewed credential could not be saved, so uploads have stopped — run \`agentboard connect ${DIR}\` again`,
      });
    }
  });

  it("reads failures without an HTTP status, and upgrade attempts, from the hooks' record", async () => {
    fs.writeFileSync(
      path.join(configDir, "project-renewal.json"),
      JSON.stringify({
        v: 1,
        failures: { aaaa: { at: "x", code: "save_failed", token_fp: "0123456789abcdef" }, junk: { at: "x" } },
        upgrades: { aaaa: { at: "y", outcome: "legacy" }, bbbb: { at: "y", outcome: "nonsense" } },
      })
    );
    const m = await import("../../src/core/project-credential-status");
    expect(m.readProjectRenewalFailures()).toEqual({ aaaa: { at: "x", status: undefined, code: "save_failed" } });
    expect(m.readProjectUpgradeAttempts()).toEqual({ aaaa: { at: "y", outcome: "legacy" } });
  });
});

describe("reportProjectCredentials", () => {
  const binding = (ref: string, label: string) => ({
    abs_dir: `/work/${label}`,
    real_dir: `/work/${label}`,
    server: { api_base_url: "https://acme/api/proxy", app_base_url: "https://acme", label: "Acme" },
    project_label: label,
    credential_ref: ref,
    connected_at: "2026-09-13T00:00:00.000Z",
  });

  it("pairs each connection with the refusal recorded for its own credential", async () => {
    fs.writeFileSync(
      path.join(configDir, "project-renewal.json"),
      JSON.stringify({
        v: 1,
        failures: {
          aaaa: { at: "2026-09-12T00:00:00Z", status: 403, code: "revoked_device" },
          // A connection removed since — must not surface anywhere.
          gone: { at: "2026-09-12T00:00:00Z", status: 403, code: "not_a_member" },
        },
        upgrades: { bbbb: { at: "2026-09-13T00:00:00Z", outcome: "legacy" } },
      })
    );
    const { reportProjectCredentials } = await import("../../src/core/project-credential-status");
    const creds: Record<string, string> = { aaaa: credential(10), bbbb: credential(60) };

    const rows = reportProjectCredentials(
      [binding("aaaa", "billing-api"), binding("bbbb", "web")],
      (ref) => creds[ref] ?? null,
      NOW
    );

    expect(rows).toEqual([
      {
        label: "billing-api -> Acme",
        ok: false,
        message: "this device was revoked on the server; uploads are blocked — run `agentboard connect /work/billing-api` again",
      },
      { label: "web -> Acme", ok: true, message: "renews automatically (expires 2026-11-12)" },
    ]);
  });

  it("reads a corrupt record as no refusals", async () => {
    fs.writeFileSync(path.join(configDir, "project-renewal.json"), "{not json");
    const { readProjectRenewalFailures } = await import("../../src/core/project-credential-status");
    expect(readProjectRenewalFailures()).toEqual({});
  });
});

// ★ 훅(.mjs)과 CLI(.ts)는 코드를 공유할 수 없다. 둘이 다른 날 갱신한다고 판단하면
//   status 는 "다음 업로드에 갱신" 이라는데 훅은 갱신하지 않는 상태가 된다.
describe("policy mirror", () => {
  it("the CLI and the hooks agree on when a project credential is due", async () => {
    const ts = await import("../../src/core/refresh-policy");
    // @ts-expect-error — plain ESM mirror without type declarations
    const mjs = await import("../../plugin/hooks/lib/refresh-policy.mjs");

    expect(mjs.DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS).toBe(ts.DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS);
    expect(mjs.PROJECT_RENEW_THRESHOLD_ENV).toBe(ts.PROJECT_RENEW_THRESHOLD_ENV);

    const cases: Array<[Record<string, unknown> | null, NodeJS.ProcessEnv]> = [
      [{ iat: nowSec - 60 * DAY, exp: nowSec + 30 * DAY }, {}],
      [{ iat: nowSec - 59 * DAY, exp: nowSec + 31 * DAY }, {}],
      [{ iat: nowSec - 30, exp: nowSec + 60 }, {}],
      [{ iat: nowSec - 10 * DAY, exp: nowSec + 80 * DAY }, { AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS: String(85 * DAY) }],
      [{ iat: nowSec - 80 * DAY, exp: nowSec + 10 * DAY }, { AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS: "abc" }],
      [{ iat: nowSec }, {}],
      [null, {}],
    ];
    for (const [claims, env] of cases) {
      expect(mjs.isProjectRenewalDue(claims, NOW, env)).toBe(ts.isProjectRenewalDue(claims, NOW, env));
    }
  });
});
