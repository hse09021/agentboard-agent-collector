#!/usr/bin/env node
/**
 * agentboard Claude Code background worker
 *
 * The heavy half of the Claude Code hook. claude/session-end.mjs (registered on
 * both Stop and SessionEnd) captures the payload and spawns this worker
 * detached, so the interactive session never blocks on collection. Invoked with
 * one argument: the path to a temp JSON payload.
 *
 * Workflow:
 *   1. Read & delete the payload file
 *   2. Confirm it's a Claude Code session (detectSource; anything else is dropped)
 *   3. Parse the transcript (incl. <session>/subagents/*.jsonl) for cumulative usage
 *   4. Reduce to the delta since the last upload (dedup via hook-sent.json)
 *   5. On SessionEnd, force a rate-limit snapshot (per-turn Stop stays throttled)
 *   6. Build a UsageEvent, run the privacy guard, POST to the agentboard API
 *   7. Record the cumulative totals as sent
 */

import { unlinkSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const DEBUG_LOG = join(
  process.env.APPDATA ?? join(tmpdir(), 'agentboard'),
  'agentboard',
  'hook-debug.log'
);

function workerLog(msg) {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [worker] ${msg}\n`);
  } catch { /* best-effort */ }
}

// Absolute lifetime ceiling for the detached worker. Every network call
// (transport AbortSignal.timeout) and CLI capture (usage-limit timeoutMs, which
// SIGKILLs its child) is already individually bounded, but this is the last-
// resort guard: no matter what await hangs, an orphaned worker can never
// outlive this. Comfortably longer than the sum of those inner timeouts so it
// only ever fires on a genuine hang, never on slow-but-normal work. `.unref()`
// so the timer itself never keeps the process alive.
const WORKER_MAX_LIFETIME_MS = 60_000;

import {
  loadConfig,
  loadToken,
  generateEventId,
  getSentTotals,
  markTotalsSent,
  computeDelta,
  acquireSessionLock,
  releaseSessionLock,
  COLLECTOR_VERSION,
  getApiBaseUrl,
} from '../lib/config.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { assertNoForbiddenFields, sanitizeRawOutput } from '../lib/forbidden-data-guard.mjs';
import { parseClaudeSession } from './parse-claude.mjs';
import { captureUsageLimitSnapshot } from '../lib/usage-limit.mjs';

// ─── Source detection ─────────────────────────────────────────────────────────

// This worker only collects Claude Code (Codex is collected separately by
// codex/notify.mjs). Anything else — including payloads from tools this
// collector used to support — returns null and is dropped by the caller,
// rather than falling back to a guess.
function detectSource(payload) {
  const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? '';
  const sessionId =
    payload.session_id ?? payload.sessionId ?? basename(transcriptPath, '.jsonl');

  // Claude Code: session JSONL in ~/.claude/projects/.../*.jsonl
  if (transcriptPath.endsWith('.jsonl')) {
    return { source: 'claude_code', sessionId, transcriptPath };
  }

  return null;
}

// ─── UsageEvent builder ───────────────────────────────────────────────────────

function buildUsageEvent(deviceId, source, sessionId, parsed) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source,
    model: parsed.model,
    session_id: sessionId,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt ?? new Date().toISOString(),
    input_tokens: parsed.inputTokens,
    output_tokens: parsed.outputTokens,
    cache_creation_tokens: parsed.cacheCreationTokens ?? 0,
    cache_read_tokens: parsed.cacheReadTokens,
    total_tokens: parsed.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

// A usage-limit-only event: no token data was parsed, but we still have a
// `/usage`/`/status` snapshot worth uploading. `total_tokens: 0` is valid
// per the (relaxed) server schema.
function buildUsageOnlyEvent(deviceId, source, sessionId) {
  const now = new Date().toISOString();
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source,
    session_id: sessionId,
    started_at: now,
    ended_at: now,
    total_tokens: 0,
    collector_version: COLLECTOR_VERSION,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  workerLog(`started pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))}`);

  const watchdog = setTimeout(() => {
    workerLog(`WATCHDOG: exceeded ${WORKER_MAX_LIFETIME_MS}ms, force-exiting`);
    process.stderr.write('agentboard-worker: watchdog timeout, force-exiting\n');
    process.exit(1);
  }, WORKER_MAX_LIFETIME_MS);
  watchdog.unref();

  // Recursion guard (defense-in-depth; session-end.mjs already bails earlier).
  // The usage-limit snapshot runs `claude -p /usage`, whose hooks inherit
  // AGENTBOARD_INTERNAL=1. Never collect for that internal invocation.
  if (process.env.AGENTBOARD_INTERNAL === '1') {
    workerLog('SKIP: internal invocation (AGENTBOARD_INTERNAL=1), not collecting');
    process.exit(0);
  }

  const payloadFile = process.argv[2];
  if (!payloadFile) {
    workerLog('ERROR: no payload file argument');
    process.stderr.write('agentboard-worker: no payload file argument\n');
    process.exit(1);
  }

  // 1. Read & delete payload file
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
    workerLog(`payload keys=${Object.keys(payload).join(',')}`);
  } catch (err) {
    workerLog(`ERROR: cannot read payload: ${err.message}`);
    process.stderr.write(`agentboard-worker: cannot read payload: ${err.message}\n`);
    process.exit(1);
  }
  try { unlinkSync(payloadFile); } catch { /* best-effort */ }

  // 2. Load agentboard config
  const config = loadConfig();
  const token = loadToken();

  if (!config || !token) {
    workerLog('SKIP: not logged in (no config or token)');
    process.exit(0);
  }

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);

  // 3. Detect source
  const detected = detectSource(payload);
  if (!detected) {
    process.stderr.write('agentboard-worker: cannot detect source from payload\n');
    process.exit(0);
  }

  const { source, sessionId, transcriptPath } = detected;
  workerLog(`source=${source} sessionId=${sessionId} transcriptPath=${transcriptPath}`);

  // 3.5 One in-flight upload per session. Must be taken before reading the
  // sent-totals ledger: a concurrent worker that read the same totals would
  // upload an overlapping delta the server can't dedup. Skipping is safe —
  // this invocation's tokens ride along in the next invocation's delta.
  if (!acquireSessionLock(source, sessionId)) {
    workerLog(`SKIP: another worker holds the lock for ${source}:${sessionId}`);
    process.exit(0);
  }
  process.on('exit', () => releaseSessionLock(source, sessionId));

  // 4. Parse session
  //
  // Dedup happens after parsing, not before: a Claude Code session can be
  // resumed and fires on both Stop (per turn) and SessionEnd, so what matters
  // is how many tokens are new since the last upload, which is only known once
  // the session is parsed.
  let parsed = null;
  try {
    if (source === 'claude_code') {
      parsed = parseClaudeSession(transcriptPath);
    }
  } catch (err) {
    workerLog(`ERROR: parse error [${source}]: ${err.message} stack=${err.stack}`);
    process.stderr.write(`agentboard-worker: parse error [${source}]: ${err.message}\n`);
    process.exit(0);
  }

  workerLog(`parsed totalTokens=${parsed?.totalTokens ?? 'null'}`);

  // 5. Reduce the cumulative session totals to only what is new since the last
  // upload. `parsed` is kept as the cumulative figure to persist afterwards.
  const cumulative = parsed;
  if (parsed) {
    const alreadySent = getSentTotals(source, sessionId);
    const delta = computeDelta(parsed, alreadySent);
    workerLog(
      `delta totalTokens=${delta.totalTokens} (cumulative=${parsed.totalTokens}, alreadySent=${alreadySent.totalTokens})`
    );
    parsed = { ...parsed, ...delta };
  }

  // 5.5 Best-effort usage-limit snapshot (`/usage`), fully independent of token
  // parse outcome — must never block or fail the existing token-collection path.
  // On SessionEnd (the last invocation before the session goes idle) bypass the
  // 10-min throttle so the resting 5h/weekly value reflects the true
  // end-of-session state rather than a reading up to 10 min stale; per-turn Stop
  // invocations stay throttled.
  let usageSnapshot = null;
  if (source === 'claude_code') {
    try {
      const forceCapture = payload.hook_event_name === 'SessionEnd';
      usageSnapshot = await captureUsageLimitSnapshot(
        source,
        forceCapture ? { minIntervalMs: 0 } : {}
      );
      workerLog(`usageSnapshot=${usageSnapshot ? 'captured' : 'none'} force=${forceCapture}`);
    } catch (err) {
      workerLog(`WARN: usage-limit capture threw unexpectedly: ${err.message}`);
      usageSnapshot = null;
    }
  }

  const hasTokens = !!parsed && parsed.totalTokens > 0;
  if (!hasTokens && !usageSnapshot) {
    workerLog(`SKIP: no tokens and no usage snapshot (parsed=${parsed ? 'non-null' : 'null'})`);
    process.exit(0);
  }

  // 6. Build event
  const event = hasTokens
    ? buildUsageEvent(deviceId, source, sessionId, parsed)
    : buildUsageOnlyEvent(deviceId, source, sessionId);
  if (usageSnapshot) {
    event.usage_snapshot = {
      ...usageSnapshot,
      raw: sanitizeRawOutput(usageSnapshot.raw),
    };
  }

  // 6.5 Privacy guard — never let a field carrying prompt/code/path/command
  // data reach the upload call. This must run on the exact object being
  // uploaded, right before the network call.
  try {
    assertNoForbiddenFields(event);
  } catch (err) {
    workerLog(`BLOCKED: forbidden field detected, upload aborted: ${err.message}`);
    process.stderr.write(`agentboard-worker: forbidden field detected, upload aborted: ${err.message}\n`);
    process.exit(1);
  }

  // 7. Send to API
  try {
    workerLog(`uploading event_id=${event.event_id} total_tokens=${event.total_tokens}`);
    await uploadEvents(apiBaseUrl, token, deviceId, [event]);
    workerLog('upload success');
  } catch (err) {
    workerLog(`ERROR: upload failed: ${err.message}`);
    process.stderr.write(`agentboard-worker: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  // 8. Record the cumulative totals now uploaded, so the next invocation for
  // this session only sends what accrues after this point. Skipped when the
  // session had no tokens at all (usage-snapshot-only upload) — writing zeroed
  // totals there would discard what a previous invocation had already recorded.
  if (cumulative) {
    markTotalsSent(source, sessionId, cumulative);
  }
  workerLog('done');
  process.exit(0);
}

main().catch((err) => {
  workerLog(`ERROR: unexpected: ${err.message} stack=${err.stack}`);
  process.stderr.write(`agentboard-worker: unexpected error: ${err.message}\n`);
  process.exit(1);
});
