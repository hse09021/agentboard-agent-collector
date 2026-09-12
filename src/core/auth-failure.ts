/**
 * Reading the authentication failure a hook could not report.
 *
 * Hooks have no stdout anyone reads, so when refresh fails permanently they
 * write the fact to ~/.agentboard/auth-failure.json instead. `status` and
 * `doctor` surface it — otherwise collection stops silently and the dashboard
 * just quietly stops growing.
 *
 * Written by plugin/hooks/lib/auth-failure.mjs — keep the shape in sync.
 */

import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "./config";

export interface AuthFailureRecord {
  /** ISO timestamp of the failure. */
  at: string;
  reason: string;
  source?: string;
  api_base_url?: string;
}

export function getAuthFailurePath(): string {
  return path.join(getConfigDir(), "auth-failure.json");
}

export function readAuthFailure(): AuthFailureRecord | null {
  const target = getAuthFailurePath();
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reason !== "string") return null;
    return {
      at: typeof obj.at === "string" ? obj.at : "",
      reason: obj.reason,
      source: typeof obj.source === "string" ? obj.source : undefined,
      api_base_url:
        typeof obj.api_base_url === "string" ? obj.api_base_url : undefined,
    };
  } catch {
    return null;
  }
}

/** Cleared by a successful `login`, so a stale warning cannot outlive the fix. */
export function clearAuthFailure(): void {
  try {
    const target = getAuthFailurePath();
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch {
    /* best-effort */
  }
}
