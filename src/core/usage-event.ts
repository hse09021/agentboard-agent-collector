// Generated from package.json by scripts/generate-version.mjs (run by `npm run build`).
// Re-exported here so every existing importer keeps working unchanged.
export { COLLECTOR_VERSION } from "./version";

// Wire-format version of the UsageEvent payload. The server pins this value
// exactly (`z.literal("1.0")`), so bumping it without a coordinated server
// change makes every event fail validation.
// Keep in sync with plugin/hooks/lib/config.mjs.
export const SCHEMA_VERSION = "1.0" as const;

// Sources this collector actively collects from. Hook registration, session
// parsing and CLI output are all scoped to these.
export type AgentSource = "claude_code" | "codex";

export const SUPPORTED_SOURCES: Array<AgentSource> = ["claude_code", "codex"];

// Best-effort snapshot of a CLI's own rate-limit status (Claude Code `/usage`,
// Codex `/status`). `raw` is always present, even when parsing fails, so the
// server can retain it for offline inspection / future re-parsing.
export interface UsageSnapshot {
  raw: string;
  parseOk: boolean;
  capturedAt: string;
  planName?: string;
  fiveHourRemainingPct?: number;
  weeklyRemainingPct?: number;
  fiveHourResetAt?: string;
  weeklyResetAt?: string;
}

export interface UsageEvent {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  user_id?: string;
  device_id: string;
  source: AgentSource;
  model?: string;
  session_id: string;
  started_at: string;
  ended_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  total_tokens: number;
  estimated_cost_usd?: number;
  collector_version: string;
  os?: "macos" | "windows" | "linux" | "unknown";
  editor?: "vscode" | "jetbrains" | "terminal" | "unknown";
  usage_snapshot?: UsageSnapshot;
}
