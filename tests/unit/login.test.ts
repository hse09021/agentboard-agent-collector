import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "../../src/api/client";

// login은 프롬프트/네트워크/파일시스템을 모두 건드리므로 경계를 전부 모킹한다.
const saveToken = vi.fn();
const saveConfig = vi.fn();
const registerDevice = vi.fn();

// 붙여넣는 값은 테스트마다 바뀐다(단일 JWT / 토큰 쌍 JSON / base64 / 깨진 입력).
let pastedValue = "";

vi.mock("readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(pastedValue),
    close: () => {},
  }),
}));

// 저장돼 있는 자격증명. 테스트마다 없음 / 레거시 / 정상 번들로 바꾼다.
let storedBundle: { v: number; access: string; refresh: string | null } | null = null;

vi.mock("../../src/platform/credential-store", () => ({
  saveToken: (token: unknown) => saveToken(token),
  loadTokenBundle: () => storedBundle,
}));

vi.mock("../../src/core/auth-failure", () => ({
  clearAuthFailure: () => {},
}));

/** 서명은 검증되지 않으므로 claims 만 맞으면 된다. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

const ACCESS_JWT = makeJwt({ sub: "u1", iat: 1_760_000_000, exp: 1_760_003_600 });

vi.mock("../../src/core/config", () => ({
  loadConfig: () => ({
    api_base_url: "https://api.example.test",
    app_base_url: "https://app.example.test",
  }),
  getOrCreateDeviceId: () => "dev_test",
  saveConfig: (patch: unknown) => saveConfig(patch),
}));

vi.mock("../../src/core/device-id", () => ({
  generateDeviceId: () => "dev_fresh",
}));

vi.mock("../../src/api/client", async () => {
  const actual = await vi.importActual<typeof import("../../src/api/client")>(
    "../../src/api/client"
  );
  return {
    ...actual,
    createApiClient: () => ({ registerDevice }),
  };
});

// process.exit(1)을 예외로 바꿔 커맨드가 정말 중단되는지 확인한다.
class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  storedBundle = null;
  pastedValue = ACCESS_JWT;
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runLogin(options: { force?: boolean } = {}) {
  const { loginCommand } = await import("../../src/cli/commands/login");
  return loginCommand(options);
}

/** console.warn/log 로 나간 모든 줄을 한 덩어리로. */
function output(): string {
  const calls = [
    ...(console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ...(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls,
  ];
  return calls.map((args) => args.join(" ")).join("\n");
}

const LEGACY_STORED = { v: 1, access: "legacy-jwt", refresh: null };
const ROTATABLE_STORED = { v: 1, access: "acc", refresh: "r1" };

// ── 이슈 #6 ──────────────────────────────────────────────────────────────────
// 업그레이드한 기존 사용자는 .token에 레거시 JWT 가 있다는 이유로 조기 리턴에
// 막혀, v=2 로그인 URL을 볼 기회조차 없었다. 레거시는 회전할 수 없으므로
// 스스로 새 형식으로 넘어갈 방법이 없다 — 만료까지 영영 레거시로 남는다.
describe("loginCommand — 레거시 토큰에서 업그레이드", () => {
  it("레거시 토큰이 저장돼 있으면 조기 리턴하지 않고 로그인을 진행한다", async () => {
    storedBundle = LEGACY_STORED;
    registerDevice.mockResolvedValue({});
    pastedValue = JSON.stringify({ v: 1, access: ACCESS_JWT, refresh: "r_new" });

    await runLogin();

    // 실제로 전환됐는가 — 새 번들이 저장돼야 한다.
    expect(saveToken).toHaveBeenCalledTimes(1);
    expect(saveToken.mock.calls[0][0]).toMatchObject({ refresh: "r_new" });
    expect(output()).not.toContain("Already logged in");
  });

  it("왜 다시 로그인해야 하는지 설명한다", async () => {
    storedBundle = LEGACY_STORED;
    registerDevice.mockResolvedValue({});
    pastedValue = JSON.stringify({ v: 1, access: ACCESS_JWT, refresh: "r_new" });

    await runLogin();

    // 방금까지 멀쩡히 쓰던 사용자다. 이유 없는 재인증 요구는 버그로 읽힌다.
    expect(output()).toMatch(/cannot be renewed automatically/i);
  });

  it("회전 가능한 번들이면 예전처럼 조기 리턴한다", async () => {
    storedBundle = ROTATABLE_STORED;

    await runLogin();

    expect(output()).toContain("Already logged in");
    expect(saveToken).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
  });

  it("저장된 것이 없으면 예전처럼 진행한다", async () => {
    storedBundle = null;
    registerDevice.mockResolvedValue({});

    await runLogin();

    expect(output()).not.toContain("Already logged in");
    expect(saveToken).toHaveBeenCalledTimes(1);
  });

  // 전환에 실패했다고 기존 자격증명을 잃으면 안 된다. 멀쩡히 돌던 수집이
  // 업그레이드를 시도했다는 이유로 끊기는 셈이다.
  it("전환에 실패해도 기존 토큰을 덮어쓰지 않는다", async () => {
    storedBundle = LEGACY_STORED;
    registerDevice.mockRejectedValue(new ApiError(401, "unauthorized"));
    pastedValue = JSON.stringify({ v: 1, access: ACCESS_JWT, refresh: "r_new" });

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(saveToken).not.toHaveBeenCalled();
    expect(output()).toMatch(/existing sign-in is unchanged/i);
  });

  it("--force 는 레거시 안내 없이 그대로 동작한다", async () => {
    storedBundle = LEGACY_STORED;
    registerDevice.mockResolvedValue({});

    await runLogin({ force: true });

    expect(saveToken).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain("Already logged in");
  });
});

describe("loginCommand", () => {
  it("saves the token and registers the device on success", async () => {
    registerDevice.mockResolvedValue({
      device_id: "dev_test",
      registered_at: "2026-01-01T00:00:00Z",
    });

    await runLogin();

    expect(registerDevice).toHaveBeenCalledOnce();
    expect(saveToken).toHaveBeenCalledWith(
      expect.objectContaining({ access: ACCESS_JWT, refresh: null })
    );
    expect(saveConfig).toHaveBeenCalledWith({ device_id: "dev_test" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // 회귀 테스트: 이전에는 검증 전에 saveToken()을 호출해서, 서버가 토큰을 거절해도
  // .token 파일이 남아 hasToken()이 true가 되고 이후 로그인된 것처럼 동작했다.
  it("does not save the token when the server rejects it (401)", async () => {
    registerDevice.mockRejectedValue(new ApiError(401, "Unauthorized"));

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(saveToken).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not save the token on 403", async () => {
    registerDevice.mockRejectedValue(new ApiError(403, "Forbidden"));

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(saveToken).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not save the token when the server errors (500)", async () => {
    registerDevice.mockRejectedValue(new ApiError(500, "boom"));

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(saveToken).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not save the token when the server is unreachable", async () => {
    const netErr: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
    netErr.code = "ECONNREFUSED";
    registerDevice.mockRejectedValue(netErr);

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(saveToken).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // revoke 는 서버가 같은 device_id를 영구히 거부하므로, 사람이 다시 인증한
  // 이 시점에 새 기기로 연결하지 않으면 사용자는 config를 손으로 지우는 것 말고
  // 복구할 방법이 없다. 훅에서는 절대 하면 안 되는 동작이지만 여기서는 맞다.
  it("reconnects as a new device when this one was revoked", async () => {
    registerDevice
      .mockRejectedValueOnce(
        new ApiError(403, '{"code":"revoked_device"}', "revoked_device")
      )
      .mockResolvedValueOnce({
        device_id: "dev_fresh",
        registered_at: "2026-01-01T00:00:00Z",
      });

    await runLogin();

    expect(registerDevice).toHaveBeenCalledTimes(2);
    expect(registerDevice.mock.calls[0][0].device_id).toBe("dev_test");
    expect(registerDevice.mock.calls[1][0].device_id).toBe("dev_fresh");
    expect(saveToken).toHaveBeenCalledWith(
      expect.objectContaining({ access: ACCESS_JWT })
    );
    expect(saveConfig).toHaveBeenCalledWith({ device_id: "dev_fresh" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("retries the revoked device only once", async () => {
    registerDevice.mockRejectedValue(
      new ApiError(403, '{"code":"revoked_device"}', "revoked_device")
    );

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(registerDevice).toHaveBeenCalledTimes(2);
    expect(saveToken).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // 403 이어도 revoked_device 가 아니면 토큰 문제다 — 새 기기로 바꿔봐야 소용없다.
  it("does not mint a new device id for a plain 403", async () => {
    registerDevice.mockRejectedValue(new ApiError(403, "Forbidden"));

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(registerDevice).toHaveBeenCalledOnce();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  // ─── v=2 토큰 쌍 붙여넣기 ──────────────────────────────────────────────────

  it("stores the refresh token when the server issues a pair", async () => {
    pastedValue = JSON.stringify({
      v: 1,
      access: ACCESS_JWT,
      access_expires_at: 1_760_003_600,
      refresh: "opaque-refresh",
      refresh_expires_at: 1_768_000_000,
    });
    registerDevice.mockResolvedValue({
      device_id: "dev_test",
      registered_at: "2026-01-01T00:00:00Z",
    });

    await runLogin();

    expect(saveToken).toHaveBeenCalledWith(
      expect.objectContaining({
        access: ACCESS_JWT,
        refresh: "opaque-refresh",
        access_expires_at: 1_760_003_600,
        refresh_expires_at: 1_768_000_000,
      })
    );
  });

  // 한 줄 JSON 은 복사하다 잘리기 쉬워서 로그인 페이지가 base64 로 감쌀 수 있다.
  it("accepts a base64-wrapped token pair", async () => {
    pastedValue = Buffer.from(
      JSON.stringify({ v: 1, access: ACCESS_JWT, refresh: "opaque-refresh" })
    ).toString("base64");
    registerDevice.mockResolvedValue({
      device_id: "dev_test",
      registered_at: "2026-01-01T00:00:00Z",
    });

    await runLogin();

    expect(saveToken).toHaveBeenCalledWith(
      expect.objectContaining({ access: ACCESS_JWT, refresh: "opaque-refresh" })
    );
  });

  // 잘린 붙여넣기를 토큰으로 취급해 저장하면, 인증은 실패하는데 hasToken()은
  // true 가 되어 "로그인됨"으로 보인다. 서버에 보내기 전에 멈춰야 한다.
  it("rejects a truncated paste without contacting the server", async () => {
    pastedValue = '{"v":1,"access":"eyJ';

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(registerDevice).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects an empty paste", async () => {
    pastedValue = "   ";

    await expect(runLogin()).rejects.toThrow(ExitError);

    expect(registerDevice).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("asks for v=2 so the server issues a pair", async () => {
    registerDevice.mockResolvedValue({
      device_id: "dev_test",
      registered_at: "2026-01-01T00:00:00Z",
    });
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });

    await runLogin();

    const url = printed.concat((console.log as unknown as { mock?: { calls: unknown[][] } }).mock?.calls.flat().map(String) ?? []).join("\n");
    expect(url).toContain("v=2");
    expect(url).toContain("device_id=dev_test");
  });
});
