import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "../../src/api/client";

// login은 프롬프트/네트워크/파일시스템을 모두 건드리므로 경계를 전부 모킹한다.
const saveToken = vi.fn();
const saveConfig = vi.fn();
const registerDevice = vi.fn();

vi.mock("readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb("pasted-token"),
    close: () => {},
  }),
}));

vi.mock("../../src/platform/credential-store", () => ({
  saveToken: (token: string) => saveToken(token),
  hasToken: () => false,
}));

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

async function runLogin() {
  const { loginCommand } = await import("../../src/cli/commands/login");
  return loginCommand();
}

describe("loginCommand", () => {
  it("saves the token and registers the device on success", async () => {
    registerDevice.mockResolvedValue({
      device_id: "dev_test",
      registered_at: "2026-01-01T00:00:00Z",
    });

    await runLogin();

    expect(registerDevice).toHaveBeenCalledOnce();
    expect(saveToken).toHaveBeenCalledWith("pasted-token");
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

  // revoke 는 서버가 같은 device_id 를 영구히 거부하므로, 사람이 다시 인증한
  // 이 시점에 새 기기로 연결하지 않으면 사용자는 config 를 손으로 지우는 것 말고
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
    expect(saveToken).toHaveBeenCalledWith("pasted-token");
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
});
