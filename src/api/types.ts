export interface RegisterDeviceRequest {
  device_id: string;
  collector_version: string;
  os?: string;
}

export interface RegisterDeviceResponse {
  device_id: string;
  registered_at: string;
}

export interface BatchUploadRequest {
  device_id: string;
  events: unknown[];
}

export interface BatchUploadResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
}

export interface UsageSummary {
  period: "week" | "month";
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  estimated_cost_usd: number;
  session_count: number;
  active_days: number;
  favorite_agent: string | null;
}

export interface UsageBySource {
  source: string;
  total_tokens: number;
  session_count: number;
  estimated_cost_usd: number;
  percentage: number;
}

/** GET /v1/me/collector/devices — 이 계정에 등록된 기기 한 대. */
export interface CollectorDeviceSummary {
  device_id: string;
  name: string | null;
  os: string | null;
  collector_version: string | null;
  last_seen_at: string | null;
  last_usage_at: string | null;
  created_at: string;
  revoked: boolean;
}
