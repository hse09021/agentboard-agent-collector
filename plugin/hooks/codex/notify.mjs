#!/usr/bin/env node
/**
 * agentboard Codex CLI notify hook
 *
 * Registered in ~/.codex/config.toml as:
 *   notify = ["/path/to/node", "/path/to/codex/notify.mjs"]
 *
 * Codex CLI calls this script after each turn (not just session end),
 * passing a JSON payload as the last argument:
 *   {"thread-id":"<uuid>","status":"..."}
 *
 * Because Codex fires notify per-turn and the session file may not be
 * fully written yet, this script retries up to RETRY_MAX times with a
 * short delay before giving up.
 */

import {
  parseCodexFile,
  findCodexSessionFile,
  findLatestCodexSessionFile,
} from './parse-codex.mjs';
import { buildUsageEvent, buildUsageOnlyEvent } from './event.mjs';
import {
  loadConfig,
  loadToken,
  getSentTotals,
  markTotalsSent,
  acquireSessionLock,
  releaseSessionLock,
  getApiBaseUrl,
} from '../lib/config.mjs';
import { splitSessionDelta } from '../lib/daily-split.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { captureUsageLimitSnapshot } from '../lib/usage-limit.mjs';
import { assertNoForbiddenFields, sanitizeRawOutput } from '../lib/forbidden-data-guard.mjs';

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

async function main() {
  // Recursion guard: mirrors session-end.mjs. The Claude usage-limit snapshot
  // spawns `claude -p /usage` with AGENTBOARD_INTERNAL=1; anything it launches
  // inherits that env, so refuse to collect when it's set.
  if (process.env.AGENTBOARD_INTERNAL === '1') {
    process.exit(0);
  }

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

  // One in-flight upload per thread. Notify fires per turn, and a slow run
  // (retry loop + upload) can still be going when the next turn's notify
  // starts; both would read the same sent-totals and upload overlapping
  // deltas. The lock is keyed on the notify payload's thread id — a losing
  // invocation exits and its tokens ride along in the next turn's delta.
  // Pinned to a const because `sessionId` may be reassigned below (latest-
  // session fallback), and release must use the exact key that was acquired.
  const lockSessionId = sessionId;
  if (!acquireSessionLock('codex', lockSessionId)) {
    process.exit(0);
  }
  process.on('exit', () => releaseSessionLock('codex', lockSessionId));

  // Run best-effort, throttled rate-limit capture concurrently with the
  // token-parse retry loop below — never lets a slow/failed CLI call delay
  // or break token collection. Codex capture is ON: it reads rate limits via
  // `codex app-server`'s stdio JSON-RPC `account/rateLimits/read` (a safe
  // account-metadata read, no billable turn) — see the SAFETY note in
  // lib/usage-limit.mjs. (The unsafe `codex exec "/status"` path, which burns
  // a real turn, stays permanently unused.)
  const usageSnapshotPromise = captureUsageLimitSnapshot('codex').catch(() => null);

  // The retry loop exists because codex may not have flushed the turn's tokens
  // yet — only the file's CONTENTS change across attempts, not which file it is.
  // So resolve the path instead of re-parsing via a fresh tree walk each time:
  //  - `findCodexSessionFile` (walk-by-name) is retried only until the id-matched
  //    file exists (a brand-new session file can appear a beat late), then cached.
  //  - the latest-session fallback (`findLatestCodexSessionFile`, which stat()s
  //    every file) is computed at most once, not every attempt.
  let sessionFile = null; // id-matched file, once found
  let latestFallback; // undefined = not yet computed; null = computed, none found
  let parsed = null;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    if (!sessionFile) sessionFile = findCodexSessionFile(sessionId);
    let fileToParse = sessionFile;
    if (!fileToParse) {
      if (latestFallback === undefined) latestFallback = findLatestCodexSessionFile();
      fileToParse = latestFallback;
    }
    parsed = fileToParse ? parseCodexFile(fileToParse) : null;
    if (parsed?.sessionId) sessionId = parsed.sessionId;
    if (parsed && parsed.totalTokens > 0) break;
    if (attempt < RETRY_MAX - 1) await sleep(RETRY_DELAY_MS);
  }

  const usageSnapshot = await usageSnapshotPromise;

  // Codex notify fires per-turn, so `parsed` (when present) holds the
  // session's cumulative totals. Upload only the delta since the last turn
  // we reported; otherwise the same session's later tokens would be dropped
  // by session-level dedup. The delta is split per calendar day so a thread
  // resumed the next day reports that day's tokens under that day. If nothing
  // parsed at all, there's no delta to compute — fall through to the
  // usage-snapshot-only path below.
  let pieces = [];
  if (parsed && parsed.totalTokens > 0) {
    if (parsed.sessionId) sessionId = parsed.sessionId;
    const alreadySent = getSentTotals('codex', sessionId);
    pieces = splitSessionDelta(parsed, alreadySent);
  }
  const hasTokens = pieces.length > 0;

  if (!hasTokens && !usageSnapshot) {
    process.exit(0);
  }

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);
  // One event per day, all under the same session id: the server counts
  // distinct session ids per bucket, so this stays one session per day rather
  // than becoming several sessions.
  const events = hasTokens
    ? pieces.map((piece) => buildUsageEvent(deviceId, sessionId, parsed.model, piece))
    : [buildUsageOnlyEvent(deviceId, sessionId)];
  // The snapshot is a point-in-time rate-limit reading, not per-day data —
  // attach it to the most recent event only.
  if (usageSnapshot) {
    events[events.length - 1].usage_snapshot = {
      ...usageSnapshot,
      raw: sanitizeRawOutput(usageSnapshot.raw),
    };
  }

  // Privacy guard — never let a field carrying prompt/code/path/command data
  // reach the upload call. Runs on the exact objects being uploaded, right
  // before the network call (mirrors worker.mjs).
  try {
    for (const event of events) assertNoForbiddenFields(event);
  } catch (err) {
    process.stderr.write(`agentboard-codex: forbidden field detected, upload aborted: ${err.message}\n`);
    process.exit(1);
  }

  try {
    // One batch, so a partial failure can't advance the ledger past days that
    // never landed.
    await uploadEvents(apiBaseUrl, token, deviceId, events);
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
