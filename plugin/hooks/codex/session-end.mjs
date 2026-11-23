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
import { isRevokedDeviceError, revokedDeviceMessage } from '../lib/revoked.mjs';
import {
  loadConfigV2,
  getSentTotals,
  acquireSessionLock,
  releaseSessionLock,
} from '../lib/config.mjs';
import { resolveUploadPlan, uploadSessionDelta } from '../lib/upload-context.mjs';
import { ForbiddenDataError } from '../lib/forbidden-data-guard.mjs';
import { readStdin } from '../lib/read-stdin.mjs';
import { recordAgentHomesFromEnv } from '../lib/agent-homes.mjs';
import { isSweepEnabled, maybeSpawnSweep } from '../lib/sweep.mjs';

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

  // Session end is the one moment worth bypassing the sweep throttle: whatever
  // a differently-homed sub-agent produced during this session should land now
  // rather than wait for the next hook on some future turn. Forced here for the
  // same reason the rate-limit snapshot below uses minIntervalMs: 0.
  recordAgentHomesFromEnv();
  if (isSweepEnabled(loadConfigV2())) {
    maybeSpawnSweep({ source: 'codex', sessionId, force: true });
  }

  // The route (and therefore the credential) depends on the working directory,
  // which the hook payload carries. Resolved here so every later step uses the
  // right server.
  const plan = resolveUploadPlan({ source: 'codex', sessionId, cwd: payload.cwd });
  if (!plan.ok) {
    process.stderr.write(`agentboard-codex-sessionend: ${plan.reason}\n`);
    process.exit(0);
  }

  // 1. Force a rate-limit snapshot (throttle bypassed for the end-of-session
  //    resting value). Reads codex app-server's rate limits — a metadata RPC,
  //    not a billable turn, and it does not fire codex hooks, so no recursion.
  const usageSnapshot = await captureUsageLimitSnapshot('codex', {
    minIntervalMs: 0,
    route: plan.route.routeId,
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
  //    drops legitimate tokens. The ledger is read inside the lock: taking the
  //    lock first is what guarantees a concurrent notify has not advanced it
  //    between the read and the upload.
  let parsed = null;
  if (acquireSessionLock('codex', sessionId)) {
    process.on('exit', () => releaseSessionLock('codex', sessionId));
    if (getSentTotals('codex', sessionId).totalTokens > 0) {
      const session = parseCodexSession(sessionId);
      // Split per calendar day (and at the connection, for a hand-off):
      // residue from a thread that ran past midnight belongs to the day it
      // accrued on, not to the thread's start date.
      if (session && session.totalTokens > 0) parsed = session;
    }
  }

  if (!parsed && !usageSnapshot) process.exit(0);

  try {
    const outcome = await uploadSessionDelta(plan, {
      source: 'codex',
      ledgerKey: sessionId,
      parsed,
      buildEvent: (deviceId, piece, watermark) =>
        buildUsageEvent(deviceId, sessionId, parsed.model, piece, watermark),
      snapshot: usageSnapshot,
      buildSnapshotOnlyEvent: (deviceId) => buildUsageOnlyEvent(deviceId, sessionId),
    });

    // A 2xx does not mean every event landed — the server reports per-event
    // rejections inside the body. Advancing the ledger past something the
    // server might still accept loses those tokens for good.
    if (outcome.status === 'held') {
      process.stderr.write('agentboard: server rejected this upload; it will be retried.\n');
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof ForbiddenDataError) {
      process.stderr.write(
        `agentboard-codex-sessionend: forbidden field detected, upload aborted: ${err.message}\n`
      );
      process.exit(1);
    }
    if (isRevokedDeviceError(err)) {
      process.stderr.write(revokedDeviceMessage('agentboard-codex-sessionend'));
      process.exit(1);
    }
    process.stderr.write(`agentboard-codex-sessionend: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
