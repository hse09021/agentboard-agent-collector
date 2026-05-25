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
  cached_tokens: number;
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
