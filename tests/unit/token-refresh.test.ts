/**
 * Rotation itself (stage 3), CLI side.
 *
 * The failure modes worth pinning: a transient server problem must NOT look
 * like a logout (the current access token is probably still good), a dead
 * refresh token must NOT look transient (it will never recover on its own), and
 * a refresh must never be attempted twice with the same refresh token — the
 * server reads that as theft and burns the family.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let configDir: string;
const API = "https://api.example.test";

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-refresh-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.stubEnv("AGENTBOARD_REFRESH_THRESHOLD_SECONDS", "300");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
});

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A token minted `age` seconds ago with a one-hour lifetime. */
function accessToken(age: number): string {
  const iat = nowSec() - age;
  return makeJwt({ iat, exp: iat + 3600 });
}

async function writeBundle(bundle: Record<string, unknown>) {
  const { saveTokenBundle } = await import("../../src/platform/credential-store");
  saveTokenBundle(bundle as never);
}

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl as never);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ensureFreshToken", () => {
  it("does not call the server when the token has plenty of life left", async () => {
    const fresh = accessToken(10);
    await writeBundle({ v: 1, access: fresh, access_expires_at: nowSec() + 3590, refresh: "r1" });
    const fetchSpy = mockFetch(() => jsonResponse({}));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("current");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rotates and persists when the token is near expiry", async () => {
    await writeBundle({
      v: 1,
      access: accessToken(3500),
      access_expires_at: nowSec() + 100,
      refresh: "r1",
    });
    const newAccess = accessToken(0);
    const fetchSpy = mockFetch(() =>
      jsonResponse({
        v: 1,
        access: newAccess,
        access_expires_at: nowSec() + 3600,
        refresh: "r2",
        refresh_expires_at: nowSec() + 7_776_000,
      })
    );

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("refreshed");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${API}/v1/auth/token/refresh`);
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
      refresh: "r1",
    });

    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()).toMatchObject({ access: newAccess, refresh: "r2" });
  });

  // 서버가 잠깐 죽은 것과 로그아웃된 것은 전혀 다르다. 전자에서 토큰을 버리면
  // 멀쩡한 사용자가 재로그인하게 된다.
  it("keeps the existing bundle when the server returns 5xx", async () => {
    await writeBundle({
      v: 1,
      access: "old-access",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    mockFetch(() => new Response("boom", { status: 503 }));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("unavailable");
    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()).toMatchObject({ access: "old-access", refresh: "r1" });
  });

  it("keeps the existing bundle when the network is down", async () => {
    await writeBundle({
      v: 1,
      access: "old-access",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    mockFetch(() => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("unavailable");
    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()?.refresh).toBe("r1");
  });

  // refresh 도 만료(90일 오프라인)면 스스로 회복할 수 없다 — 재로그인뿐이다.
  it("reports reauth_required when the refresh token is rejected", async () => {
    await writeBundle({
      v: 1,
      access: "old-access",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    mockFetch(() => new Response('{"code":"invalid_refresh"}', { status: 401 }));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("reauth_required");
  });

  // 레거시 토큰은 회전할 수단이 없다. 만료가 한참 남았으면 그대로 쓰고(current),
  // 만료가 임박해서야 재로그인을 요구한다 — 아직 멀쩡한 토큰을 두고 "로그인하라"고
  // 하면 쓸데없이 사용자를 쫓아내는 셈이다.
  it("leaves a healthy legacy token alone and never calls the refresh endpoint", async () => {
    // 기본 통지 창(7일) 밖. 30일짜리 레거시 토큰의 평상시 상태다.
    await writeBundle({
      v: 1,
      access: "legacy",
      access_expires_at: nowSec() + 30 * 24 * 60 * 60,
      refresh: null,
    });
    const fetchSpy = mockFetch(() => jsonResponse({}));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("current");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 이슈 #7 의 본체. 이 분기는 예전에 isDueForRefresh() 의 not-due 조기 리턴 뒤에
  // 있어 force 없이는 닿지 않았고, force 를 쓰지 않는 훅은 만료될 때까지 레거시
  // 토큰을 멀쩡한 토큰으로 취급했다.
  it("asks for a re-login once a legacy token nears expiry", async () => {
    await writeBundle({
      v: 1,
      access: "legacy",
      access_expires_at: nowSec() + 60 * 60, // 통지 창(7일) 안
      refresh: null,
    });
    const fetchSpy = mockFetch(() => jsonResponse({}));

    const { ensureFreshToken, LEGACY_TOKEN_REASON } = await import(
      "../../src/api/token-refresh"
    );
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("reauth_required");
    if (outcome.kind === "reauth_required") {
      expect(outcome.reason).toBe(LEGACY_TOKEN_REASON);
    }
    // 회전할 수단이 없으므로 서버를 부르지 않는다 — 불러봐야 401 이다.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 만료를 읽을 수 없으면 근거 없는 경고가 된다. 침묵이 맞다.
  it("stays quiet for a legacy token whose expiry cannot be read", async () => {
    await writeBundle({ v: 1, access: "opaque-no-exp", refresh: null });
    const fetchSpy = mockFetch(() => jsonResponse({}));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("current");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 통지 창은 access 임계값과 별개여야 한다. 30일짜리 토큰에 300초 임계값을 쓰면
  // 수집이 끊기기 5분 전에 알리게 된다.
  it("uses its own notice window, not the access threshold", async () => {
    vi.stubEnv("AGENTBOARD_REFRESH_THRESHOLD_SECONDS", "300");
    vi.stubEnv("AGENTBOARD_LEGACY_NOTICE_SECONDS", "86400");
    await writeBundle({
      v: 1,
      access: "legacy",
      access_expires_at: nowSec() + 12 * 60 * 60, // 300초 밖, 24시간 안
      refresh: null,
    });
    mockFetch(() => jsonResponse({}));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    expect((await ensureFreshToken(API)).kind).toBe("reauth_required");
  });

  // 401 이후의 force 경로. 서버가 방금 이 토큰을 거절했으므로 만료가 한참
  // 남았든 말든 회복할 방법이 없다 — 통지 창과 무관하게 재로그인을 요구해야 한다.
  it("reports reauth_required when a legacy token is force-refreshed after a 401", async () => {
    await writeBundle({
      v: 1,
      access: "legacy",
      access_expires_at: nowSec() + 30 * 24 * 60 * 60, // 통지 창 밖
      refresh: null,
    });
    const fetchSpy = mockFetch(() => jsonResponse({}));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API, { force: true });

    expect(outcome.kind).toBe("reauth_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 서버가 access 만 주고 refresh 를 회전시키지 않을 수 있다. 그때 기존 refresh 를
  // 버리면 다음 갱신이 영영 불가능해진다.
  it("carries the old refresh token forward when the server does not rotate it", async () => {
    await writeBundle({
      v: 1,
      access: "old",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    mockFetch(() => jsonResponse({ v: 1, access: "new", access_expires_at: nowSec() + 3600 }));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    await ensureFreshToken(API);

    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()).toMatchObject({ access: "new", refresh: "r1" });
  });

  // 2xx 인데 access 가 없는 응답을 저장하면 사용자를 잠가버린다.
  it("does not persist a 2xx response with no access token", async () => {
    await writeBundle({
      v: 1,
      access: "old",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    mockFetch(() => jsonResponse({ v: 1 }));

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe("unavailable");
    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()?.access).toBe("old");
  });

  it("force refreshes a token that is not yet near expiry", async () => {
    await writeBundle({
      v: 1,
      access: accessToken(10),
      access_expires_at: nowSec() + 3590,
      refresh: "r1",
    });
    const fetchSpy = mockFetch(() =>
      jsonResponse({ v: 1, access: "new", access_expires_at: nowSec() + 3600, refresh: "r2" })
    );

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcome = await ensureFreshToken(API, { force: true });

    expect(outcome.kind).toBe("refreshed");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // 같은 refresh 를 두 번 제출하면 서버가 탈취로 보고 family 를 폐기한다.
  // 락 안에서 파일을 다시 읽어, 이미 다른 프로세스가 갱신했으면 그 결과를 쓴다.
  it("submits the refresh token only once across concurrent callers", async () => {
    await writeBundle({
      v: 1,
      access: "old",
      access_expires_at: nowSec() + 10,
      refresh: "r1",
    });
    const fetchSpy = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return jsonResponse({
        v: 1,
        access: accessToken(0),
        access_expires_at: nowSec() + 3600,
        refresh: "r2",
      });
    });

    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    const outcomes = await Promise.all([
      ensureFreshToken(API),
      ensureFreshToken(API),
      ensureFreshToken(API),
    ]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(outcomes.every((o) => o.kind === "refreshed" || o.kind === "current")).toBe(true);

    const { loadTokenBundle } = await import("../../src/platform/credential-store");
    expect(loadTokenBundle()?.refresh).toBe("r2");
  });

  it("reports reauth_required when nothing is stored", async () => {
    const { ensureFreshToken } = await import("../../src/api/token-refresh");
    expect((await ensureFreshToken(API)).kind).toBe("reauth_required");
  });
});

describe("revokeRefreshToken", () => {
  it("posts the refresh token to the revoke endpoint", async () => {
    const fetchSpy = mockFetch(() => new Response(null, { status: 204 }));

    const { revokeRefreshToken } = await import("../../src/api/token-refresh");
    const result = await revokeRefreshToken(API, "r1");

    expect(result.ok).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${API}/v1/auth/token/revoke`);
  });

  // 서버가 이미 모른다면 logout 이 원하던 상태다.
  it("treats an already-unknown token as success", async () => {
    mockFetch(() => new Response(null, { status: 404 }));

    const { revokeRefreshToken } = await import("../../src/api/token-refresh");
    expect((await revokeRefreshToken(API, "r1")).ok).toBe(true);
  });

  it("never throws when the server is unreachable", async () => {
    mockFetch(() => {
      throw new Error("offline");
    });

    const { revokeRefreshToken } = await import("../../src/api/token-refresh");
    const result = await revokeRefreshToken(API, "r1");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("offline");
  });
});
