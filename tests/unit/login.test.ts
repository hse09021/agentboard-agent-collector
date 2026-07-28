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
});
