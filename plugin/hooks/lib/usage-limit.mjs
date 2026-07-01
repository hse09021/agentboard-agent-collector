/**
 * agentboard usage-limit snapshot orchestrator
 *
 * Combines throttle + collector + parser into one best-effort call.
 * Never throws — any failure resolves to `null`, and callers should treat
 * that as "no snapshot this time," never as a reason to skip token upload.
 *
 * SAFETY:
 *   - `codex exec "/status"` does NOT run the /status slash command
 *     headlessly — confirmed against codex-cli 0.142.4 (see /codex.md) that
 *     it treats the string as a fresh agent prompt and runs a real,
 *     billable turn. That path (`codexStatusCommand()`) stays permanently
 *     unused.
 *   - codex IS captured, but via a completely different, verified-safe
 *     mechanism: `codex app-server`'s stdio JSON-RPC `account/rateLimits/read`
 *     (see `readCodexRateLimits()` in usage-limit-collector.mjs). Confirmed
 *     2026-07-01: never opens a `thread/start` (no session/turn), produces
 *     zero new files under `~/.codex/sessions` or `~/.codex/log`, and
 *     returns byte-identical `usedPercent` across 8 back-to-back calls (no
 *     quota drift from the read itself). This is a pure account-metadata
 *     read, architecturally nothing like `codex exec`.
 *   - claude_code: verified 2026-07-01 against Claude Code 2.1.197 that
 *     `spawn('claude', ['-p', '/usage'])` (no shell involved) produces a
 *     session transcript entry of `type: "system", subtype:
 *     "local_command"` with zero assistant turns, meaning the CLI
 *     intercepts `/usage` locally and never calls the model. (Typing
 *     `claude -p "/usage"` at a Git Bash prompt is NOT equivalent — MSYS
 *     path-mangles the leading `/` into a Windows path, which *does* make
 *     the CLI misinterpret it as a real, billable prompt. spawn() bypasses
 *     that shell entirely.)
 *
 *   Both sources are ON BY DEFAULT. Set
 *   AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE=0 to opt out of both.
 */

import { claudeUsageCommand, captureUsageLimitRaw, readCodexRateLimits } from './usage-limit-collector.mjs';
import { parseUsageLimitText, normalizeCodexRateLimits } from './parse-usage-limit.mjs';
import { shouldCaptureUsageLimit, markUsageLimitCaptured } from './usage-limit-throttle.mjs';

async function captureClaudeCode(opts) {
  const { command, args } = claudeUsageCommand();
  const result = await captureUsageLimitRaw({ command, args, timeoutMs: opts.timeoutMs });
  if (!result.raw || !result.raw.trim()) return null;
  return parseUsageLimitText(result.raw, { source: 'claude_code' });
}

async function captureCodex(opts) {
  const result = await readCodexRateLimits({ timeoutMs: opts.timeoutMs });
  if (!result.ok || !result.result) return null;
  return normalizeCodexRateLimits(result.result, result.raw);
}

const SOURCE_CAPTURERS = {
  claude_code: captureClaudeCode,
  codex: captureCodex,
};

function isCaptureEnabled() {
  return process.env.AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE !== '0';
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

    const capture = SOURCE_CAPTURERS[source];
    if (!capture) return null;
    if (!shouldCaptureUsageLimit(source, { minIntervalMs: opts.minIntervalMs })) return null;

    const parsed = await capture(opts);

    // Mark captured regardless of success — a failing CLI shouldn't be retried every session.
    markUsageLimitCaptured(source);

    if (!parsed) return null;

    return { ...parsed, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}
