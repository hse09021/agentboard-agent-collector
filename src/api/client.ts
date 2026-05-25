import {
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  BatchUploadResponse,
  UsageSummary,
  UsageBySource,
} from "./types";
import { UsageEvent, COLLECTOR_VERSION } from "../core/usage-event";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authToken = authToken;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/json",
      "User-Agent": `agentboard-collector/${COLLECTOR_VERSION}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ApiError(response.status, text);
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

  async uploadBatch(
    deviceId: string,
    events: UsageEvent[]
  ): Promise<BatchUploadResponse> {
    return this.request<BatchUploadResponse>("POST", "/v1/events/usage/batch", {
      device_id: deviceId,
      events,
    });
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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "ApiError";
  }
}

export function createApiClient(baseUrl: string, authToken: string): ApiClient {
  return new ApiClient(baseUrl, authToken);
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
