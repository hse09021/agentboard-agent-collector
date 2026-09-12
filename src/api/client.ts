import {
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  UsageSummary,
  UsageBySource,
  CollectorDeviceSummary,
} from "./types";
import { COLLECTOR_VERSION } from "../core/usage-event";
import { ensureFreshToken } from "./token-refresh";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiClient {
  private readonly baseUrl: string;
  private authToken: string;
  /**
   * Whether this client may rotate its own credential.
   *
   * Only the default route's token is part of a refresh family. A per-project
   * `.cred` (from `agentboard connect`) is a separate enrollment credential
   * that the server does not rotate, and submitting it to the refresh endpoint
   * would be a straight error — so clients built for those routes opt out.
   */
  private readonly autoRefresh: boolean;

  constructor(
    baseUrl: string,
    authToken: string,
    options: { autoRefresh?: boolean } = {}
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authToken = authToken;
    this.autoRefresh = options.autoRefresh ?? false;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/json",
      "User-Agent": `agentboard-collector/${COLLECTOR_VERSION}`,
    };
  }

  /**
   * Rotates the stored token when it is near expiry, adopting whatever is on
   * disk. Returns whether a newer access token is now in use.
   *
   * A transient failure is deliberately silent: the current token usually still
   * works, and the 401 path below is the backstop.
   */
  private async refreshIfNeeded(force: boolean): Promise<boolean> {
    if (!this.autoRefresh) return false;
    const outcome = await ensureFreshToken(this.baseUrl, { force });
    if (
      (outcome.kind === "refreshed" || outcome.kind === "current") &&
      outcome.bundle.access !== this.authToken
    ) {
      this.authToken = outcome.bundle.access;
      return true;
    }
    return outcome.kind === "refreshed";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    // Pre-emptive: refreshing before the request beats reacting to a 401,
    // because the 401 path costs a round trip and the hooks that share this
    // behaviour have little retry room.
    await this.refreshIfNeeded(false);

    const send = () =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

    let response = await send();

    // Second line of defence, capped at one retry so a server that answers 401
    // to everything cannot spin us into a refresh loop.
    if (response.status === 401 && (await this.refreshIfNeeded(true))) {
      response = await send();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ApiError(response.status, text, extractErrorCode(text));
    }

    return response.json() as Promise<T>;
  }

  async registerDevice(
    request: RegisterDeviceRequest
  ): Promise<RegisterDeviceResponse> {
    return this.request<RegisterDeviceResponse>(
      "POST",
      "/v1/collector/devices",
      request
    );
  }


  /**
   * 이 계정의 기기 목록. doctor/status 가 "이 기기가 대시보드에서 끊겼는지"를
   * 알아내는 유일한 경로다 — 업로드를 실제로 시도하기 전에는 403을 볼 수 없다.
   */
  async getDevices(): Promise<CollectorDeviceSummary[]> {
    return this.request<CollectorDeviceSummary[]>(
      "GET",
      "/v1/me/collector/devices"
    );
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getUsageSummary(period: "week" | "month"): Promise<UsageSummary> {
    return this.request<UsageSummary>(
      "GET",
      `/v1/me/usage/summary?period=${period}`
    );
  }

  async getUsageBySource(period: "week" | "month"): Promise<UsageBySource[]> {
    return this.request<UsageBySource[]>(
      "GET",
      `/v1/me/usage/by-source?period=${period}`
    );
  }
}

/**
 * Pulls the machine-readable `code` out of a server error body.
 *
 * The server has emitted these since the first release (`device_not_found`,
 * `revoked_device`) but nothing ever read them, so a wiped server database
 * looked exactly like a network failure. Returns undefined for non-JSON or
 * code-less bodies, which is the normal case for 4xx from the web proxy.
 */
export function extractErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    /** Server-supplied error code, e.g. "device_not_found". */
    public readonly code?: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "ApiError";
  }
}

/**
 * A client for an arbitrary credential (e.g. a per-project `.cred`). Does not
 * rotate — see ApiClient#autoRefresh.
 */
export function createApiClient(baseUrl: string, authToken: string): ApiClient {
  return new ApiClient(baseUrl, authToken);
}

/**
 * A client for the default route, which rotates the stored `.token` bundle as
 * needed. Use this for anything that talks to the server the user logged into.
 */
export function createDefaultRouteClient(
  baseUrl: string,
  authToken: string
): ApiClient {
  return new ApiClient(baseUrl, authToken, { autoRefresh: true });
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.includes("fetch")) return true;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENETUNREACH"
    );
  }
  return false;
}
