#!/usr/bin/env node
/**
 * agentboard Codex SessionEnd hook
 *
 * Registered in ~/.codex/hooks.json under `SessionEnd` (fires on normal close,
 * archive/delete of an open conversation, or after ~30 min idle). Two jobs,
 * both best-effort:
 *   1. Force a fresh rate-limit snapshot (bypassing the 10-min throttle) so the
 *      dashboard's "resting" 5h/weekly value reflects the true end-of-session
 *      state instead of a reading up to 10 min stale.
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
import { buildUsageEvent, buildUsageOnlyEvent } from './event.mjs';
import { captureUsageLimitSnapshot } from '../lib/usage-limit.mjs';
import {
  loadConfigV2,
  getSentTotals,
  markTotalsSent,
  acquireSessionLock,
  releaseSessionLock,
} from '../lib/config.mjs';
import { splitSessionDelta } from '../lib/daily-split.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { resolveUploadContext } from '../lib/upload-context.mjs';
import { assertNoForbiddenFields, sanitizeRawOutput } from '../lib/forbidden-data-guard.mjs';
import { readStdin } from '../lib/read-stdin.mjs';

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

  // The route (and therefore the credential) depends on the working directory,
  // which the hook payload carries. Resolved here so every later step uses the
  // right server.
  const ctx = resolveUploadContext({
    source: 'codex',
    sessionId: sessionId,
    cwd: payload.cwd,
  });
  if (!ctx.ok) {
    process.stderr.write(`agentboard-codex-sessionend: ${ctx.reason}\n`);
    process.exit(0);
  }
  const { apiBaseUrl, deviceId, token, route } = ctx;

  // 1. Force a rate-limit snapshot (throttle bypassed for the end-of-session
  //    resting value). Reads codex app-server's rate limits — a metadata RPC,
  //    not a billable turn, and it does not fire codex hooks, so no recursion.
  const usageSnapshot = await captureUsageLimitSnapshot('codex', {
    minIntervalMs: 0,
    route: route.routeId,
  }).catch(() => null);

  // 2. Guarded parent-session token residue sweep, under the SAME per-session
  //    lock notify.mjs takes. A final notify still uploading this session
  //    could otherwise race us into double-counting the residue. The lock is
  //    acquired AFTER the (slow) snapshot capture so it's held only for the
  //    quick parse+upload, and the snapshot upload below never depends on it —
  //    if we lose the lock we skip only the token sweep, not the snapshot.
  //
  //    We also only sweep a session notify has already reported (alreadySent
  //    > 0): that proves the SessionEnd `session_id` matches the id notify keys
  //    the ledger on (otherwise the lookup would miss and we'd re-upload the
  //    whole session as a bogus "delta") and gives a baseline to diff against.
  //    Any session with tokens has fired notify at least once, so this never
  //    drops legitimate tokens.
  let parsed = null;
  let pieces = [];
  if (acquireSessionLock('codex', sessionId)) {
    process.on('exit', () => releaseSessionLock('codex', sessionId));
    const alreadySent = getSentTotals('codex', sessionId);
    if (alreadySent.totalTokens > 0) {
      parsed = parseCodexSession(sessionId);
      if (parsed && parsed.totalTokens > 0) {
        // Split per calendar day: residue from a thread that ran past midnight
        // belongs to the day it accrued on, not to the thread's start date.
        pieces = splitSessionDelta(parsed, alreadySent);
      }
    }
  }
  const hasTokens = pieces.length > 0;

  if (!hasTokens && !usageSnapshot) process.exit(0);

  const events = hasTokens
    ? pieces.map((piece) => buildUsageEvent(deviceId, sessionId, parsed.model, piece))
    : [buildUsageOnlyEvent(deviceId, sessionId)];
  // Point-in-time rate-limit reading — most recent event only.
  if (usageSnapshot) {
    events[events.length - 1].usage_snapshot = {
      ...usageSnapshot,
      raw: sanitizeRawOutput(usageSnapshot.raw),
    };
  }

  try {
    for (const event of events) assertNoForbiddenFields(event);
  } catch (err) {
    process.stderr.write(
      `agentboard-codex-sessionend: forbidden field detected, upload aborted: ${err.message}\n`
    );
    process.exit(1);
  }

  try {
    const verdict = await uploadEvents(apiBaseUrl, token, deviceId, events);

    // A 2xx does not mean every event landed — the server reports per-event
    // rejections inside the body. Advancing the ledger past something the
    // server might still accept loses those tokens for good.
    if (verdict && !verdict.canAdvanceLedger) {
      process.stderr.write('agentboard: server rejected this upload; it will be retried.\n');
      process.exit(1);
    }
    if (hasTokens) markTotalsSent('codex', sessionId, parsed, route.routeId);
  } catch (err) {
    process.stderr.write(`agentboard-codex-sessionend: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
