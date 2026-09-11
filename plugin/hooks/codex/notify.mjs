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

import { parseCodexFile, findCodexSessionFile } from './parse-codex.mjs';
import { recordAgentHomesFromEnv } from '../lib/agent-homes.mjs';
import { buildUsageEvent, buildUsageOnlyEvent } from './event.mjs';
import {
  loadConfigV2,
  getSentRoute,
  getSentTotals,
  markTotalsSent,
  acquireSessionLock,
  releaseSessionLock,
} from '../lib/config.mjs';
import { splitSessionDelta } from '../lib/daily-split.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { resolveUploadContext } from '../lib/upload-context.mjs';
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

  // Cheap early gate. The credential cannot be resolved yet: it depends on the
  // route, which depends on the working directory, which only appears once the
  // rollout file has been parsed below.
  const config = loadConfigV2();
  if (!config) {
    process.exit(0);
  }

  // This process was spawned by the Codex that is running, so it inherits that
  // Codex's CODEX_HOME. Recording it is what makes an orchestrator-launched
  // agent (Orca points CODEX_HOME at its own runtime home) discoverable later.
  recordAgentHomesFromEnv();

  // One in-flight upload per thread. Notify fires per turn, and a slow run
  // (retry loop + upload) can still be going when the next turn's notify
  // starts; both would read the same sent-totals and upload overlapping
  // deltas. A losing invocation exits and its tokens ride along in the next
  // turn's delta.
  //
  // `sessionId` is never reassigned after this point, so the lock key, the
  // ledger key and the uploaded session_id are one and the same value. They
  // used to diverge: the lock was taken on the payload thread id while the
  // ledger was keyed on an id adopted from whatever file got parsed, so in
  // exactly the case where they differed the lock guarded the wrong key.
  if (!acquireSessionLock('codex', sessionId)) {
    process.exit(0);
  }
  process.on('exit', () => releaseSessionLock('codex', sessionId));

  // Run best-effort, throttled rate-limit capture concurrently with the
  // token-parse retry loop below — never lets a slow/failed CLI call delay
  // or break token collection. Codex capture is ON: it reads rate limits via
  // `codex app-server`'s stdio JSON-RPC `account/rateLimits/read` (a safe
  // account-metadata read, no billable turn) — see the SAFETY note in
  // lib/usage-limit.mjs. (The unsafe `codex exec "/status"` path, which burns
  // a real turn, stays permanently unused.)
  // The capture is started concurrently with the parse retry loop below, so the
  // routed destination is not known yet. The session's pin is readable without
  // parsing, and after the first upload that is exactly the route this session
  // uses — good enough to key the throttle. A brand-new session falls back to
  // the default key, costing at most one extra capture on its first turn.
  const throttleRoute = getSentRoute('codex', sessionId) ?? undefined;
  const usageSnapshotPromise = captureUsageLimitSnapshot('codex', {
    route: throttleRoute,
  }).catch(() => null);

  // The retry loop exists because codex may not have flushed the turn's tokens
  // yet — only the file's CONTENTS change across attempts, not which file it is.
  // So resolve the path once and re-read it, rather than re-walking the tree:
  // `findCodexSessionFile` (walk-by-name, across every Codex home) is retried
  // only until the id-matched file exists — a brand-new rollout can appear a
  // beat late — and then cached.
  //
  // There is deliberately no "newest file anywhere" fallback. It existed for
  // Codex builds whose notify thread-id does not map to the rollout filename,
  // but what it actually did was hand this hook an unrelated session: the
  // parsed id was then adopted as `sessionId`, so another thread's ledger entry
  // was diffed against this file and the result routed to that thread's server.
  // A session we cannot identify is now simply left alone — the cross-agent
  // sweep collects it later, with its own id, its own cwd and its own route.
  let sessionFile = null; // id-matched file, once found
  let parsed = null;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    if (!sessionFile) sessionFile = findCodexSessionFile(sessionId);
    parsed = sessionFile ? parseCodexFile(sessionFile) : null;
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
    const alreadySent = getSentTotals('codex', sessionId);
    pieces = splitSessionDelta(parsed, alreadySent);
  }
  const hasTokens = pieces.length > 0;

  if (!hasTokens && !usageSnapshot) {
    process.exit(0);
  }

  // Codex's notify payload carries only {thread-id, status}, so the routing
  // anchor comes from session_meta.cwd in the rollout file. It is used to pick
  // a destination and never uploaded.
  const ctx = resolveUploadContext({ source: 'codex', sessionId, cwd: parsed?.cwd });
  if (!ctx.ok) {
    process.stderr.write(`agentboard-codex: ${ctx.reason}\n`);
    process.exit(0);
  }
  const { apiBaseUrl, deviceId, token, route } = ctx;

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
    const verdict = await uploadEvents(apiBaseUrl, token, deviceId, events);

    // A 2xx is not proof the events landed — the server reports per-event
    // rejections inside the body. Advancing the ledger past something the
    // server might still accept loses those tokens permanently.
    if (verdict && !verdict.canAdvanceLedger) {
      process.stderr.write('agentboard: server rejected this upload; it will be retried.\n');
      process.exit(1);
    }
    if (verdict && verdict.allRejected) {
      process.stderr.write(
        `agentboard: the server rejected every event in this upload (${JSON.stringify(verdict.reasons)}).\n`
      );
    }
    if (hasTokens) {
      // Pins the session to this route: from here on it goes to this server
      // regardless of where the user works next.
      markTotalsSent('codex', sessionId, parsed, route.routeId);
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
