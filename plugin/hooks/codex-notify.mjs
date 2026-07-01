#!/usr/bin/env node
/**
 * agentboard Codex CLI notify hook
 *
 * Registered in ~/.codex/config.toml as:
 *   notify = ["/path/to/node", "/path/to/codex-notify.mjs"]
 *
 * Codex CLI calls this script after each turn (not just session end),
 * passing a JSON payload as the last argument:
 *   {"thread-id":"<uuid>","status":"..."}
 *
 * Because Codex fires notify per-turn and the session file may not be
 * fully written yet, this script retries up to RETRY_MAX times with a
 * short delay before giving up.
 */

import { parseCodexSession, parseLatestCodexSession } from './lib/parse-codex.mjs';
import {
  loadConfig,
  loadToken,
  generateEventId,
  getSentTotals,
  markTotalsSent,
  computeDelta,
  COLLECTOR_VERSION,
  getApiBaseUrl,
} from './lib/config.mjs';
import { uploadEvents } from './lib/transport.mjs';
import { captureUsageLimitSnapshot } from './lib/usage-limit.mjs';

const RETRY_MAX = 6;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSessionId() {
  const raw = process.argv[process.argv.length - 1];
  if (!raw || raw.startsWith('-')) return null;

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return (
        obj['thread-id'] ||
        obj.thread_id ||
        obj.threadId ||
        obj.session_id ||
        null
      );
    }
  } catch {
    // Not JSON — might be a bare session ID passed directly
  }

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--thread' || args[i] === '--session') && args[i + 1]) {
      return args[i + 1];
    }
  }

  if (raw && !raw.startsWith('-') && raw.length > 8) return raw;
  return null;
}

function buildUsageEvent(deviceId, sessionId, parsed, delta) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    model: parsed.model,
    session_id: sessionId,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt ?? new Date().toISOString(),
    input_tokens: delta.inputTokens,
    output_tokens: delta.outputTokens,
    cache_read_tokens: delta.cacheReadTokens,
    total_tokens: delta.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

// A usage-limit-only event: no new token delta this turn, but a `/status`
// snapshot is still worth uploading. Valid per the (relaxed) server schema,
// which allows `total_tokens: 0`.
function buildUsageOnlyEvent(deviceId, sessionId) {
  const now = new Date().toISOString();
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    session_id: sessionId,
    started_at: now,
    ended_at: now,
    total_tokens: 0,
    collector_version: COLLECTOR_VERSION,
  };
}

async function main() {
  let sessionId = parseSessionId();

  if (!sessionId) {
    process.stderr.write('agentboard-codex: no session ID in notify payload\n');
    process.exit(0);
  }

  const config = loadConfig();
  const token = loadToken();

  if (!config || !token) {
    process.exit(0);
  }

  // Run best-effort, throttled `/status` capture concurrently with the
  // token-parse retry loop below — never lets a slow/failed CLI call delay
  // or break token collection. NOTE: this currently always resolves to
  // null for 'codex' — confirmed (codex-cli 0.142.4, see /codex.md) that
  // `codex exec "/status"` burns a real turn instead of querying status,
  // so codex capture is hard-disabled in lib/usage-limit.mjs until a safe
  // headless mechanism exists. Left wired up here so re-enabling it later
  // is a one-line change in usage-limit.mjs, not a new integration.
  const usageSnapshotPromise = captureUsageLimitSnapshot('codex').catch(() => null);

  let parsed = null;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    parsed = parseCodexSession(sessionId);
    if (!parsed) {
      parsed = parseLatestCodexSession();
      if (parsed?.sessionId) sessionId = parsed.sessionId;
    }
    if (parsed && parsed.totalTokens > 0) break;
    if (attempt < RETRY_MAX - 1) await sleep(RETRY_DELAY_MS);
  }

  const usageSnapshot = await usageSnapshotPromise;

  // Codex notify fires per-turn, so `parsed` (when present) holds the
  // session's cumulative totals. Upload only the delta since the last turn
  // we reported; otherwise the same session's later tokens would be dropped
  // by session-level dedup. If nothing parsed at all, there's no delta to
  // compute — fall through to the usage-snapshot-only path below.
  let delta = null;
  let hasTokens = false;
  if (parsed && parsed.totalTokens > 0) {
    if (parsed.sessionId) sessionId = parsed.sessionId;
    const alreadySent = getSentTotals('codex', sessionId);
    delta = computeDelta(parsed, alreadySent);
    hasTokens = delta.totalTokens > 0;
  }

  if (!hasTokens && !usageSnapshot) {
    process.exit(0);
  }

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);
  const event = hasTokens
    ? buildUsageEvent(deviceId, sessionId, parsed, delta)
    : buildUsageOnlyEvent(deviceId, sessionId);
  if (usageSnapshot) {
    event.usage_snapshot = usageSnapshot;
  }

  try {
    await uploadEvents(apiBaseUrl, token, deviceId, [event]);
    if (hasTokens) {
      markTotalsSent('codex', sessionId, parsed);
    }
  } catch (err) {
    process.stderr.write(`agentboard-codex: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`agentboard-codex: unexpected error: ${err.message}\n`);
  process.exit(0);
});
