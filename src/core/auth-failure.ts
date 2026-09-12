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
import { LEGACY_TOKEN_REASON } from "./refresh-policy";

export interface AuthFailureRecord {
  /** ISO timestamp of the failure. */
  at: string;
  reason: string;
  source?: string;
  api_base_url?: string;
}

/**
 * Turns a record into the sentence the user reads.
 *
 * A legacy token and a rejected refresh token both end collection and both need
 * `agentboard login`, but they are not the same event: one was never renewable,
 * the other was refused. Reporting "renewal failed" for a legacy token
 * describes an attempt that never took place, which sends the user looking for
 * a server problem that is not there.
 */
export function describeAuthFailure(record: AuthFailureRecord): string {
  const when = record.at ? record.at.slice(0, 19).replace("T", " ") : "";
  if (record.reason === LEGACY_TOKEN_REASON) {
    return "This device still uses a pre-0.10 token, which cannot be renewed automatically and is about to expire";
  }
  return `Automatic renewal failed${when ? ` at ${when}` : ""}: ${record.reason}`;
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
