export const COLLECTOR_VERSION = "0.3.0";

export type AgentSource =
  | "claude_code"
  | "codex"
  | "opencode"
  | "github_copilot"
  | "gemini_cli"
  | "antigravity_cli";

export const SUPPORTED_SOURCES: AgentSource[] = [
  "claude_code",
  "codex",
  "opencode",
  "github_copilot",
  "gemini_cli",
  "antigravity_cli",
];

export interface UsageEvent {
  schema_version: "1.0";
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
}
