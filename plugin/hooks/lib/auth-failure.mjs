/**
 * Recording an authentication failure a hook cannot report to anyone.
 *
 * Hooks run in the background: their stderr competes with the agent's own
 * output and is usually never read. So when the refresh token itself is
 * rejected — the 90-days-offline case, or a revoked family — there is no way to
 * tell the user that collection has stopped and only `agentboard login` will
 * restart it. Previously that meant silence until someone happened to run
 * `status`.
 *
 * The hook writes the fact here instead, and the next `status` / `doctor`
 * surfaces it. Read by src/core/auth-failure.ts — keep the shape in sync.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';

export const AUTH_FAILURE_PATH = join(CONFIG_DIR, 'auth-failure.json');

/**
 * @param {{reason?: string, source?: string, apiBaseUrl?: string}} detail
 */
export function recordAuthFailure(detail = {}) {
  try {
    const reason = detail.reason ?? 'authentication failed';

    // Rewrite only when the situation itself changed. Hooks run on every
    // session end, and the legacy-token notice repeats for as long as the user
    // has not logged in again — re-writing an identical record each time
    // churns a file other hooks are concurrently reading, and moves `at`
    // forward so the user cannot tell how long this has been true.
    const existing = readAuthFailure();
    if (existing && existing.reason === reason) return;

    writeJsonAtomic(AUTH_FAILURE_PATH, {
      at: new Date().toISOString(),
      reason,
      ...(detail.source ? { source: detail.source } : {}),
      ...(detail.apiBaseUrl ? { api_base_url: detail.apiBaseUrl } : {}),
    });
  } catch {
    // best-effort: never let bookkeeping break an upload
  }
}

/**
 * Clears the record after a successful authenticated exchange, so a stale
 * warning does not outlive the problem it described.
 */
export function clearAuthFailure() {
  try {
    if (existsSync(AUTH_FAILURE_PATH)) {
      // unlink rather than write an empty object: absence is the "nothing
      // wrong" state everywhere else in the config dir.
      unlinkSync(AUTH_FAILURE_PATH);
    }
  } catch {
    /* best-effort */
  }
}

export function readAuthFailure() {
  if (!existsSync(AUTH_FAILURE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(AUTH_FAILURE_PATH, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
