#!/usr/bin/env node
/**
 * agentboard Codex SessionEnd hook
 *
 * Registered in ~/.codex/hooks.json under `SessionEnd` (fires on normal close,
 * archive/delete of an open conversation, or after ~30 min idle). Two jobs,
 * both best-effort:
 *   1. Force a fresh rate-limit snapshot (bypassing the 15-min throttle) so the
 *      dashboard's "resting" 5h/weekly value reflects the true end-of-session
 *      state instead of a reading up to 15 min stale.
 *   2. A guarded parent-session token residue sweep: upload any tokens that
 *      accrued after the last per-turn notify (a final-turn write race, or an
 *      abnormal close where notify never fired). Delta-based, so it uploads
 *      nothing when notify already reported everything.
 *
 * NOTE: this does NOT collect subagent tokens — those live in separate child
 * rollouts and are handled by subagent-stop.mjs. SessionEnd runs for the parent
 * thread only.
 *
 * Receives one JSON object on stdin: { session_id, transcript_path, cwd, ... }.
 * Only session_id is used; transcript_path/cwd are never uploaded.
 */

import { parseCodexSession } from './parse-codex.mjs';
import { captureUsageLimitSnapshot } from '../lib/usage-limit.mjs';
import {
  loadConfig,
  loadToken,
  generateEventId,
  getSentTotals,
  markTotalsSent,
  computeDelta,
  COLLECTOR_VERSION,
  getApiBaseUrl,
} from '../lib/config.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { assertNoForbiddenFields, sanitizeRawOutput } from '../lib/forbidden-data-guard.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
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
  if (process.env.AGENTBOARD_INTERNAL === '1') process.exit(0);

  let payloadText = '';
  try {
    payloadText = await readStdin();
  } catch {
    process.exit(0);
  }

  let payload = {};
  try {
    if (payloadText.trim()) payload = JSON.parse(payloadText);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id ?? payload.sessionId;
  if (!sessionId) process.exit(0);

  const config = loadConfig();
  const token = loadToken();
  if (!config || !token) process.exit(0);

  // 1. Force a rate-limit snapshot (throttle bypassed for the end-of-session
  //    resting value). Reads codex app-server's rate limits — a metadata RPC,
  //    not a billable turn, and it does not fire codex hooks, so no recursion.
  const usageSnapshot = await captureUsageLimitSnapshot('codex', {
    minIntervalMs: 0,
  }).catch(() => null);

  // 2. Guarded parent-session token residue sweep. Only sweep a session the
  //    per-turn notify has already reported (alreadySent > 0): that both proves
  //    the SessionEnd `session_id` matches the id notify keys the ledger on
  //    (otherwise the lookup would miss and we'd re-upload the whole session as
  //    a bogus "delta", double-counting) and gives a cumulative baseline to
  //    diff against. Any session with tokens has fired notify at least once, so
  //    this never drops legitimate tokens.
  let parsed = null;
  let delta = null;
  let hasTokens = false;
  const alreadySent = getSentTotals('codex', sessionId);
  if (alreadySent.totalTokens > 0) {
    parsed = parseCodexSession(sessionId);
    if (parsed && parsed.totalTokens > 0) {
      delta = computeDelta(parsed, alreadySent);
      hasTokens = delta.totalTokens > 0;
    }
  }

  if (!hasTokens && !usageSnapshot) process.exit(0);

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);
  const event = hasTokens
    ? buildUsageEvent(deviceId, sessionId, parsed, delta)
    : buildUsageOnlyEvent(deviceId, sessionId);
  if (usageSnapshot) {
    event.usage_snapshot = {
      ...usageSnapshot,
      raw: sanitizeRawOutput(usageSnapshot.raw),
    };
  }

  try {
    assertNoForbiddenFields(event);
  } catch (err) {
    process.stderr.write(
      `agentboard-codex-sessionend: forbidden field detected, upload aborted: ${err.message}\n`
    );
    process.exit(1);
  }

  try {
    await uploadEvents(apiBaseUrl, token, deviceId, [event]);
    if (hasTokens) markTotalsSent('codex', sessionId, parsed);
  } catch (err) {
    process.stderr.write(`agentboard-codex-sessionend: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
