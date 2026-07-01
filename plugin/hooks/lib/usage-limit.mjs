/**
 * agentboard usage-limit snapshot orchestrator
 *
 * Combines throttle + collector + parser into one best-effort call.
 * Never throws — any failure resolves to `null`, and callers should treat
 * that as "no snapshot this time," never as a reason to skip token upload.
 *
 * SAFETY: confirmed against codex-cli 0.142.4 (see /codex.md) that
 * `codex exec "/status"` does NOT run the /status slash command headlessly —
 * it treats the string as a fresh agent prompt and runs a real, billable
 * turn. The same risk applies to `claude -p "/usage"` by the same
 * architectural pattern (unverified, but not proven safe either). So:
 *   - codex is HARD DISABLED — there is currently no known safe headless
 *     way to read its rate-limit status, and running the wrong command
 *     silently spends the user's real usage/quota, which is worse than a
 *     no-op.
 *   - claude_code is opt-in only (AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE=1),
 *     defaulting OFF, until someone manually verifies `claude -p "/usage"`
 *     is actually a safe, side-effect-free status query in a real
 *     Claude Code install.
 */

import { claudeUsageCommand, captureUsageLimitRaw } from './usage-limit-collector.mjs';
import { parseUsageLimitText } from './parse-usage-limit.mjs';
import { shouldCaptureUsageLimit, markUsageLimitCaptured } from './usage-limit-throttle.mjs';

// codex intentionally omitted — see SAFETY note above.
const SOURCE_COMMANDS = {
  claude_code: claudeUsageCommand,
};

function isCaptureEnabled() {
  return process.env.AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE === '1';
}

/**
 * @param {'claude_code'|'codex'} source
 * @param {{minIntervalMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<null | {
 *   raw: string, parseOk: boolean, capturedAt: string,
 *   planName?: string, fiveHourRemainingPct?: number, weeklyRemainingPct?: number,
 *   fiveHourResetAt?: string, weeklyResetAt?: string
 * }>}
 */
export async function captureUsageLimitSnapshot(source, opts = {}) {
  try {
    if (!isCaptureEnabled()) return null;

    const buildCommand = SOURCE_COMMANDS[source];
    if (!buildCommand) return null;
    if (!shouldCaptureUsageLimit(source, { minIntervalMs: opts.minIntervalMs })) return null;

    const { command, args } = buildCommand();
    const result = await captureUsageLimitRaw({ command, args, timeoutMs: opts.timeoutMs });

    // Mark captured regardless of success — a failing CLI shouldn't be retried every session.
    markUsageLimitCaptured(source);

    if (!result.raw || !result.raw.trim()) return null;

    const parsed = parseUsageLimitText(result.raw, { source });
    return { ...parsed, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}
