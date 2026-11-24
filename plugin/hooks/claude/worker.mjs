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
 *   3. Resolve the route; on Stop, wait briefly for the turn's last response
 *      to reach the transcript; then parse it (incl.
 *      <session>/subagents/*.jsonl) for cumulative usage
 *   4. On SessionEnd, force a rate-limit snapshot (per-turn Stop stays throttled)
 *   5. Reduce to the delta since the last upload (dedup via hook-sent.json),
 *      split at the connection when the session is being handed off
 *   6. Build UsageEvents, run the privacy guard, POST to the agentboard API
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

// How long a Stop waits for the turn's last response to reach the transcript
// (#25). Observed lags are 100–150ms; past this the rest goes with the next
// hook, as it did before.
const FINAL_RESPONSE_POLL_MS = 100;
const FINAL_RESPONSE_MAX_WAIT_MS = 2_000;

import {
  loadConfigV2,
  generateEventId,
  deriveEventId,
  upgradeLineCountedTotals,
  acquireSessionLock,
  releaseSessionLock,
  COLLECTOR_VERSION,
} from '../lib/config.mjs';
import { resolveUploadPlan, uploadSessionDelta, uploadWithContext } from '../lib/upload-context.mjs';
import { recordAgentHomesFromEnv } from '../lib/agent-homes.mjs';
import { isSweepEnabled, maybeSpawnSweep } from '../lib/sweep.mjs';
import { registerDevice } from '../lib/transport.mjs';
import { isRevokedDeviceError, revokedDeviceMessage } from '../lib/revoked.mjs';
import { ForbiddenDataError } from '../lib/forbidden-data-guard.mjs';
import { parseClaudeSession, convertLineCountedWatermark, finalResponseWritten } from './parse-claude.mjs';
import { captureUsageLimitSnapshot } from '../lib/usage-limit.mjs';
import { bucketEventFields } from '../lib/usage-buckets.mjs';

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

// One event per bucket key and calendar day of the delta. `piece.startedAt`
// falls inside `piece.date`, which is what makes the server file these tokens
// under the day they were actually spent rather than under the session's
// creation date. `piece.key` says what the tokens are priced as — the model
// that actually served them, its speed and prompt-size tier — so a Haiku
// subagent inside an Opus session is no longer billed as Opus. `watermark` is
// that key's ledger value this piece was computed against.
function buildUsageEvent(deviceId, source, sessionId, model, piece, watermark) {
  return {
    schema_version: '1.0',
    // Deterministic, so the server's (user_id, event_id) uniqueness can absorb
    // a racing hook or a retry after an ambiguous failure.
    event_id: deriveEventId(source, sessionId, piece, watermark),
    device_id: deviceId,
    source,
    ...bucketEventFields(piece.key, model),
    session_id: sessionId,
    started_at: piece.startedAt,
    ended_at: piece.endedAt ?? piece.startedAt,
    input_tokens: piece.inputTokens,
    output_tokens: piece.outputTokens,
    cache_creation_tokens: piece.cacheCreationTokens ?? 0,
    // Breakdown of cache_creation_tokens by TTL, not additional tokens. The two
    // are priced differently (5-minute writes at 1.25x input, 1-hour at 2x), so
    // the server needs the split to cost a cache-heavy session at all.
    cache_creation_5m_tokens: piece.cacheCreation5mTokens ?? 0,
    cache_creation_1h_tokens: piece.cacheCreation1hTokens ?? 0,
    cache_read_tokens: piece.cacheReadTokens,
    total_tokens: piece.totalTokens,
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

function detectOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

// A wiped or reinstalled server no longer knows this device. Nothing else
// re-registers from the hook path, so without this every developer goes
// silently dark until someone happens to run `agentboard login`.
// 403은 404와 정반대다. 기기가 사라진 게 아니라 사람이 끊은 것이므로
// 재등록을 시도해선 안 된다 — 그러면 revoke 가 무의미해진다.
async function uploadReregistering(ctx, events) {
  try {
    return await uploadWithContext(ctx, events, workerLog);
  } catch (err) {
    const deviceGone = /HTTP 404/.test(err.message) && /device_not_found/.test(err.message);
    if (!deviceGone) throw err;

    workerLog(`device_not_found on ${ctx.route.routeId} — attempting re-registration`);
    const reregistered = await registerDevice(ctx.apiBaseUrl, ctx.token, ctx.deviceId, { os: detectOs() });
    if (!reregistered) throw new Error(`re-registration failed after: ${err.message}`);

    const verdict = await uploadWithContext(ctx, events, workerLog);
    workerLog('upload success after re-registration');
    return verdict;
  }
}

/**
 * Claude Code writes the transcript asynchronously, and Stop can fire before
 * the turn's last response is on disk (#25). Parsed then, the upload would
 * leave that response for the next hook — the next turn, or `/exit` — so a
 * session looks like it used tokens after the conversation stopped. Nothing
 * is lost either way: giving up just keeps that behavior.
 */
async function waitForFinalResponse(transcriptPath) {
  const started = Date.now();
  let polled = false;
  for (;;) {
    const written = finalResponseWritten(transcriptPath);
    const waited = Date.now() - started;
    if (written !== false) {
      if (polled && written) workerLog(`final response reached the transcript after ${waited}ms`);
      return;
    }
    if (waited >= FINAL_RESPONSE_MAX_WAIT_MS) {
      workerLog(
        `final response not in the transcript after ${waited}ms; sending what is there, the rest goes with the next hook`
      );
      return;
    }
    if (!polled) workerLog('waiting for the final response to reach the transcript');
    polled = true;
    await new Promise((resolve) => setTimeout(resolve, FINAL_RESPONSE_POLL_MS));
  }
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

  // 2. Load agentboard config (v1 files are promoted in memory)
  const config = loadConfigV2();
  if (!config) {
    workerLog('SKIP: no config');
    process.exit(0);
  }

  // 2.5 Cross-agent collection.
  //
  // This process descends from the Claude Code that spawned it, so it inherits
  // that instance's CLAUDE_CONFIG_DIR — recording it is how an orchestrator-
  // relocated home becomes known.
  //
  // The sweep then runs detached, so it costs this worker nothing. It is what
  // collects a sub-agent running a *different* CLI: that CLI may have no
  // agentboard hooks in its own home and so never fires anything, but this hook
  // fires every turn, and the sweep picks up its sessions. Throttled inside;
  // forced on SessionEnd so the last turn's work is not left for later.
  recordAgentHomesFromEnv();
  if (isSweepEnabled(config)) {
    maybeSpawnSweep({
      source: 'claude_code',
      sessionId: payload.session_id ?? payload.sessionId,
      force: payload.hook_event_name === 'SessionEnd',
    });
  }

  // 3. Detect source
  const detected = detectSource(payload);
  if (!detected) {
    process.stderr.write('agentboard-worker: cannot detect source from payload\n');
    process.exit(0);
  }

  const { source, sessionId, transcriptPath } = detected;
  workerLog(`source=${source} sessionId=${sessionId} transcriptPath=${transcriptPath}`);

  // 3.2 Resolve which server this session's data belongs to.
  //
  // Done before the rate-limit capture because the capture is throttled per
  // route: a snapshot taken while working in one project must not be attached
  // to an upload going to a different organization's server.
  //
  // `cwd` comes from the hook payload only — never process.cwd(), which is
  // whatever the AI tool happened to launch us with and would misroute. It is
  // read here and never uploaded.
  //
  // Shared with the Codex hooks and the sweep (upload-context.mjs), so there
  // is one place that decides which server a token goes to: the default
  // route's `.token` and a connected project's `.cred` are different servers'
  // tokens, and sending either to the other server would show it to that
  // server's operator. A pinned route whose binding is gone is skipped rather
  // than falling back to another server; its tokens stay in the ledger and
  // are recovered if the binding is restored. A session that started before
  // its directory was connected is handed off at the connection: earlier
  // tokens to the community server, later ones to the organization's.
  const plan = resolveUploadPlan({ source, sessionId, cwd: payload.cwd });
  if (!plan.ok) {
    workerLog(`SKIP: ${plan.reason}`);
    process.exit(0);
  }

  workerLog(
    plan.kind === 'skip'
      ? `route=none (directory not tracked, listed scope) pinned=${plan.pinnedRoute ?? 'none'}`
      : `route=${plan.route.routeId} api=${plan.route.server.api_base_url} pinned=${plan.pinnedRoute ?? 'none'}` +
          (plan.route.since ? ` since=${plan.route.since}` : '') +
          (plan.kind === 'handoff'
            ? ` handoff_from=${plan.from?.routeId ?? 'none'} split_at=${plan.splitAt}`
            : '')
  );

  // 3.4 On Stop, let the turn's last response reach the transcript first.
  // Before the lock, so a SessionEnd right behind this Stop is not turned
  // away while this worker waits. SessionEnd needs no wait: it comes after
  // the last turn was written.
  if (source === 'claude_code' && payload.hook_event_name === 'Stop') {
    await waitForFinalResponse(transcriptPath);
  }

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

  // A record written before per-response counting holds an inflated
  // watermark; converted once here, or this session's new usage would be held
  // back until it outgrew the inflated figure.
  const upgraded = upgradeLineCountedTotals(sessionId, (lineCounted) =>
    convertLineCountedWatermark(transcriptPath, lineCounted)
  );
  if (upgraded) {
    workerLog(`ledger converted to per-response counting: ${upgraded.from} -> ${upgraded.to}`);
  }

  // 5. Best-effort usage-limit snapshot (`/usage`), fully independent of token
  // parse outcome — must never block or fail the existing token-collection path.
  // On SessionEnd (the last invocation before the session goes idle) bypass the
  // 10-min throttle so the resting 5h/weekly value reflects the true
  // end-of-session state rather than a reading up to 10 min stale; per-turn Stop
  // invocations stay throttled. Throttled under the route new usage goes to,
  // which is also the route the snapshot is attached to. A session "listed"
  // scope does not collect sends no snapshot either, so `/usage` is not run.
  let usageSnapshot = null;
  if (source === 'claude_code' && plan.kind !== 'skip') {
    try {
      const forceCapture = payload.hook_event_name === 'SessionEnd';
      const route = plan.route.routeId;
      usageSnapshot = await captureUsageLimitSnapshot(
        source,
        forceCapture ? { minIntervalMs: 0, route } : { route }
      );
      workerLog(`usageSnapshot=${usageSnapshot ? 'captured' : 'none'} force=${forceCapture}`);
    } catch (err) {
      workerLog(`WARN: usage-limit capture threw unexpectedly: ${err.message}`);
      usageSnapshot = null;
    }
  }

  // 6-8. Reduce the cumulative totals to what is new since the last upload,
  // split across the calendar days it happened on (and, for a hand-off, at the
  // moment of connection), upload, and record the cumulative totals now sent.
  // A session created yesterday and resumed today yields a piece dated today,
  // so today's tokens are no longer filed under the session's creation date.
  // One event per day, all under the same session id: the server counts
  // distinct session ids per bucket, so a session spanning two days shows up
  // as one session on each of them rather than as two sessions.
  //
  // Recording pins the session to the route it went to: from now on it goes to
  // that server no matter where the user cd's to.
  let outcome;
  try {
    outcome = await uploadSessionDelta(plan, {
      source,
      ledgerKey: sessionId,
      parsed,
      buildEvent: (deviceId, piece, watermark) =>
        buildUsageEvent(deviceId, source, sessionId, parsed.model, piece, watermark),
      snapshot: usageSnapshot,
      buildSnapshotOnlyEvent: (deviceId) => buildUsageOnlyEvent(deviceId, source, sessionId),
      upload: uploadReregistering,
      log: workerLog,
    });
  } catch (err) {
    // Privacy guard — never let a field carrying prompt/code/path/command
    // data reach the upload call.
    if (err instanceof ForbiddenDataError) {
      workerLog(`BLOCKED: forbidden field detected, upload aborted: ${err.message}`);
      process.stderr.write(`agentboard-worker: forbidden field detected, upload aborted: ${err.message}\n`);
      process.exit(1);
    }
    if (isRevokedDeviceError(err)) {
      workerLog('device revoked — halting, re-login required');
      process.stderr.write(revokedDeviceMessage('agentboard-worker'));
      process.exit(1);
    }
    workerLog(`ERROR: upload failed: ${err.message}`);
    process.stderr.write(`agentboard-worker: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  if (outcome.status === 'untracked') {
    workerLog('done (not tracked)');
    process.exit(0);
  }

  if (outcome.status === 'nothing') {
    workerLog(`SKIP: no tokens and no usage snapshot (parsed=${parsed ? 'non-null' : 'null'})`);
    process.exit(0);
  }

  if (outcome.status === 'held') {
    workerLog('HOLD: server rejected events retriably — ledger not advanced');
    process.stderr.write('agentboard: server rejected this upload; it will be retried.\n');
    process.exit(1);
  }

  // Permanent rejections are given up on, but never silently: a whole batch
  // rejected outright almost always means a version mismatch with the server,
  // and stderr is the only channel the user actually sees.
  for (const { verdict } of outcome.uploads) {
    if (verdict && verdict.allRejected) {
      process.stderr.write(
        `agentboard: the server rejected every event in this upload ` +
          `(${JSON.stringify(verdict.reasons)}). Run \`agentboard doctor\` for details.\n`
      );
    }
  }

  workerLog('done');
  process.exit(0);
}

main().catch((err) => {
  workerLog(`ERROR: unexpected: ${err.message} stack=${err.stack}`);
  process.stderr.write(`agentboard-worker: unexpected error: ${err.message}\n`);
  process.exit(1);
});
