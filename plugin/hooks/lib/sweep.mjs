/**
 * agentboard cross-agent sweep (hook runtime)
 *
 * Why this exists
 * ---------------
 * Collection is hook-driven: a CLI fires our hook, the hook parses that CLI's
 * session. That model has a hole. When an orchestrator runs one agent as the
 * "main" agent and a *different* CLI as a sub-agent, the sub-agent is a
 * separate process with its own config home — and if our hooks were never
 * installed in that home, nothing ever fires for it. Its tokens are simply
 * never seen. That is the Orca "only the main agent is counted" bug.
 *
 * The sweep closes it from the other side: whenever ANY hook fires, we also
 * look at the sessions belonging to every agent home we know about. The main
 * agent's hook fires every turn, so it collects on the sub-agent's behalf.
 *
 * What bounds it
 * --------------
 * This is a deliberate widening of what gets collected, so four limits are
 * structural, not configurable:
 *
 *   1. Registry-limited. Only homes lib/agent-homes.mjs knows about — install
 *      targets, homes observed in a hook's own environment, and deterministic
 *      orchestrator paths. The filesystem is never searched for candidates.
 *   2. No retroactive flood. Only sessions touched inside SWEEP_UPLOAD_CUTOFF_MS
 *      are uploaded. Older ones are seeded — recorded as known so their history
 *      is never sent, only what accrues from now on.
 *   3. No paths persisted. The scan cache hashes them (lib/scan-cache.mjs).
 *   4. Per-session routing. Every session resolves its OWN destination from its
 *      OWN cwd. The triggering hook's route is never inherited, and a session
 *      whose route has no credential is skipped rather than redirected. The
 *      product promise is that unconnected work cannot reach an organization's
 *      server, and that promise is structural — this must not be the thing that
 *      breaks it.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR,
  COLLECTOR_VERSION,
  deriveEventId,
  getSentTotals,
  markTotalsSeeded,
  markTotalsSentMonotonic,
  upgradeLineCountedTotals,
  acquireSessionLock,
  releaseSessionLock,
} from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { normalizePath } from './path-normalize.mjs';
import {
  listAgentHomes,
  noteMissingHomes,
  getCodexSessionsDirs,
  getClaudeProjectsDirs,
} from './agent-homes.mjs';
import { loadScanCache, saveScanCache, isUnchanged, rememberScan, getCacheEntry } from './scan-cache.mjs';
import { splitSessionDelta } from './daily-split.mjs';
import { uploadEvents } from './transport.mjs';
import { resolveUploadContextWithRefresh } from './upload-context.mjs';
import { assertNoForbiddenFields } from './forbidden-data-guard.mjs';
import { parseClaudeSession, convertLineCountedWatermark } from '../claude/parse-claude.mjs';
import { findCodexSessionFiles, parseCodexFiles } from '../codex/parse-codex.mjs';

export const SWEEP_STATE_PATH = join(CONFIG_DIR, 'sweep-state.json');

/** How often a sweep may run. An upper bound, not a timer: it only happens when
 *  a hook fires anyway. Worst-case latency for a sub-agent's tokens. */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

/** Guardrail 2. A session touched more recently than this uploads its delta;
 *  anything older is seeded instead. */
export const SWEEP_UPLOAD_CUTOFF_MS = 48 * 60 * 60 * 1000;

/** Discovery horizon. Matches HOOK_SENT_MAX_AGE_MS in config.mjs — seeding a
 *  session the ledger would prune before it could ever be used is pure waste.
 *  It is much wider than the upload cutoff on purpose: a session started months
 *  ago and resumed today must still be recognised as already-known, or its
 *  whole history would look like new tokens. */
export const SWEEP_SEED_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/** Soft budget, checked between sessions — never mid-upload. */
export const SWEEP_BUDGET_MS = 45_000;

export const SWEEP_MAX_SCAN_FILES = 2000;
export const SWEEP_MAX_UPLOADS_PER_RUN = 25;
export const SWEEP_MAX_ERRORS = 5;

/** parseSingleFile reads the whole file and splits it, so peak memory is a few
 *  times the file size. Beyond this a transcript is remembered and skipped. */
export const SWEEP_MAX_FILE_BYTES = 64 * 1024 * 1024;

// ─── Enablement ───────────────────────────────────────────────────────────────

/**
 * config.json is the real user switch — hooks do not inherit the user's shell,
 * so the environment variable is for tests and CI only.
 */
export function isSweepEnabled(config, env = process.env) {
  if (env.AGENTBOARD_INTERNAL === '1') return false;
  if (env.AGENTBOARD_SWEEP === 'off') return false;
  if (!config) return false;
  return config.sweep !== 'off';
}

// ─── Throttle state ───────────────────────────────────────────────────────────

export function readSweepState() {
  if (!existsSync(SWEEP_STATE_PATH)) return { version: 1 };
  try {
    const raw = JSON.parse(readFileSync(SWEEP_STATE_PATH, 'utf-8'));
    return raw && raw.version === 1 ? raw : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

function writeSweepState(state) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(SWEEP_STATE_PATH, state);
  } catch {
    /* best-effort */
  }
}

function elapsedSince(iso, now) {
  if (!iso) return Infinity;
  const elapsed = now - Date.parse(iso);
  return Number.isFinite(elapsed) ? elapsed : Infinity;
}

/**
 * The interval override exists for tests. It is validated rather than coerced:
 * `Number('')` is 0, so an environment variable that is merely *present and
 * empty* — routine in CI and in shells that export blanks — would otherwise
 * silently disable the throttle and let a sweep spawn on every single turn.
 */
function configuredInterval() {
  // Trimmed before the emptiness check: Number('   ') is also 0.
  const raw = process.env.AGENTBOARD_SWEEP_INTERVAL_MS?.trim();
  if (!raw) return SWEEP_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SWEEP_MIN_INTERVAL_MS;
}

/**
 * `force` (session end on either CLI) bypasses the interval. It never bypasses
 * the process lock — that is what keeps two sweeps from overlapping.
 */
export function shouldSweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const minIntervalMs = opts.minIntervalMs ?? configuredInterval();
  if (opts.force) return true;
  return elapsedSince(readSweepState().lastSweepStartedAt, now) >= minIntervalMs;
}

/** Written BEFORE the scan, so a long run does not invite a pile-up of spawns. */
export function markSweepStarted(opts = {}) {
  const state = readSweepState();
  state.lastSweepStartedAt = new Date(opts.now ?? Date.now()).toISOString();
  writeSweepState(state);
}

export function markSweepFinished(report, opts = {}) {
  const state = readSweepState();
  state.lastSweepFinishedAt = new Date(opts.now ?? Date.now()).toISOString();
  state.lastReport = report;
  writeSweepState(state);
}

// ─── Discovery ────────────────────────────────────────────────────────────────

function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Claude transcripts live at <home>/projects/<flattened-project>/<uuid>.jsonl.
 *
 * The walk is depth-2 and file-only, which excludes two things structurally
 * rather than by filter: <uuid>/subagents/*.jsonl — already folded into the
 * parent by parseClaudeSession, so enumerating them separately would count
 * every subagent twice — and <project>/memory/. A name-based filter would rot
 * the moment Claude adds another sibling directory; a fixed depth will not.
 */
export function discoverClaudeTranscriptFiles(opts = {}) {
  const now = opts.now ?? Date.now();
  const horizonMs = opts.horizonMs ?? SWEEP_SEED_HORIZON_MS;
  const maxFiles = opts.maxFiles ?? SWEEP_MAX_SCAN_FILES;
  const out = [];

  for (const projectsDir of opts.dirs ?? getClaudeProjectsDirs()) {
    for (const project of safeReaddir(projectsDir)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projectsDir, project.name);
      for (const entry of safeReaddir(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, entry.name);
        const stat = safeStat(filePath);
        if (!stat) continue;
        if (now - stat.mtimeMs > horizonMs) continue;
        out.push({
          source: 'claude_code',
          filePath,
          sessionIdHint: basename(entry.name, '.jsonl'),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
        if (out.length >= maxFiles) return sortByMtimeDesc(out);
      }
    }
  }
  return sortByMtimeDesc(out);
}

/**
 * Is a YYYY/MM/DD directory path worth descending into?
 *
 * Codex writes a rollout under the date the session STARTED, and resuming it
 * updates the file in place. So the horizon here has to be generous — pruning
 * to the upload cutoff would hide a long-running session that is active today
 * but was started last week.
 */
function dateDirInHorizon(parts, now, horizonMs) {
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y ?? '')) return true; // unrecognised layout — don't prune
  const year = Number(y);
  const month = m !== undefined ? Number(m) : 12;
  const day = d !== undefined ? Number(d) : 31;
  if (m !== undefined && !/^\d{2}$/.test(m)) return true;
  if (d !== undefined && !/^\d{2}$/.test(d)) return true;
  // End of the referenced period, so a partial path (year only) is kept when
  // any day inside it could still be in range.
  const end = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  return now - end <= horizonMs;
}

export function discoverCodexSessionFiles(opts = {}) {
  const now = opts.now ?? Date.now();
  const horizonMs = opts.horizonMs ?? SWEEP_SEED_HORIZON_MS;
  const maxFiles = opts.maxFiles ?? SWEEP_MAX_SCAN_FILES;
  const out = [];

  for (const sessionsDir of opts.dirs ?? getCodexSessionsDirs()) {
    // Bounded, date-pruned descent: sessions/YYYY/MM/DD/*.jsonl. Pruning at the
    // directory level is what keeps a home with years of history cheap.
    const stack = [{ dir: sessionsDir, parts: [] }];
    while (stack.length) {
      const { dir, parts } = stack.pop();
      for (const entry of safeReaddir(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (parts.length >= 3) continue; // deeper than YYYY/MM/DD — not our layout
          const nextParts = [...parts, entry.name];
          if (!dateDirInHorizon(nextParts, now, horizonMs)) continue;
          stack.push({ dir: full, parts: nextParts });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const stat = safeStat(full);
        if (!stat) continue;
        if (now - stat.mtimeMs > horizonMs) continue;
        out.push({
          source: 'codex',
          filePath: full,
          sessionIdHint: rolloutSessionId(entry.name),
          // Where this thread's other pages are looked up — never another home,
          // which may hold a backfilled copy of the same thread.
          sessionsDir,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
        if (out.length >= maxFiles) return sortByMtimeDesc(out);
      }
    }
  }
  return sortByMtimeDesc(out);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * rollout-2026-07-30T22-06-55-<uuid>.jsonl -> <uuid>
 * rollout-2026-07-30T23-10-00-<uuid>_<page>.jsonl -> <uuid>, the thread, so
 * every page of a thread is one session to the sweep.
 */
function rolloutSessionId(fileName) {
  const stem = basename(fileName, '.jsonl');
  const match = stem.match(new RegExp(`(${UUID})(?:_${UUID})?$`, 'i'));
  return match ? match[1] : stem;
}

/** Newest first: the copy most likely to hold the live state wins any tie, and
 *  a truncated run has done the most useful work possible. */
function sortByMtimeDesc(candidates) {
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── Event building ───────────────────────────────────────────────────────────

function buildUsageEvent(source, deviceId, sessionId, model, piece, alreadySent) {
  return {
    schema_version: '1.0',
    // Deterministic: a sweep and a direct hook that both reach the same session
    // with the same ledger watermark produce the same id, so the server's
    // (user_id, event_id) uniqueness collapses them into one accepted event.
    event_id: deriveEventId(source, sessionId, piece, alreadySent),
    device_id: deviceId,
    source,
    model,
    session_id: sessionId,
    started_at: piece.startedAt,
    ended_at: piece.endedAt ?? piece.startedAt,
    input_tokens: piece.inputTokens,
    output_tokens: piece.outputTokens,
    // Codex reports no cache-creation tokens; keep its wire shape unchanged.
    // For Claude the 5m/1h pair is a breakdown of cache_creation_tokens (priced
    // at 1.25x and 2x input respectively), not additional tokens.
    ...(source === 'claude_code'
      ? {
          cache_creation_tokens: piece.cacheCreationTokens ?? 0,
          cache_creation_5m_tokens: piece.cacheCreation5mTokens ?? 0,
          cache_creation_1h_tokens: piece.cacheCreation1hTokens ?? 0,
        }
      : {}),
    cache_read_tokens: piece.cacheReadTokens,
    total_tokens: piece.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

// ─── One session ──────────────────────────────────────────────────────────────

function parseCandidate(candidate) {
  if (candidate.source === 'claude_code') {
    const parsed = parseClaudeSession(candidate.filePath);
    return parsed ? { ...parsed, sessionId: candidate.sessionIdHint } : null;
  }
  // The ledger holds one cumulative per thread, so the whole thread is parsed
  // whichever of its pages was discovered. Diffing a single page against it is
  // what lost a thread's earlier pages once Codex moved it onto a new one.
  const pages = candidate.sessionsDir
    ? findCodexSessionFiles(candidate.sessionIdHint, { dirs: [candidate.sessionsDir] })
    : [];
  const parsed = parseCodexFiles(pages.length > 0 ? pages : [candidate.filePath]);
  if (!parsed) return null;
  return { ...parsed, sessionId: parsed.sessionId || candidate.sessionIdHint };
}

/**
 * Collect one discovered session. Never inherits anything from the caller: its
 * own cwd picks its own route, and its own ledger entry defines its own delta.
 *
 * @returns {{status: string, sessionId?: string, tokens?: number, routeId?: string, error?: string}}
 */
export async function sweepOneSession(candidate, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const uploader = ctx.uploader ?? uploadEvents;
  const cutoffMs = ctx.cutoffMs ?? SWEEP_UPLOAD_CUTOFF_MS;

  if (candidate.size > (ctx.maxFileBytes ?? SWEEP_MAX_FILE_BYTES)) {
    return { status: 'toobig' };
  }

  const parsed = parseCandidate(candidate);
  if (!parsed || !parsed.sessionId || !(parsed.totalTokens > 0)) {
    return { status: 'nodelta' };
  }

  const { source } = candidate;
  const sessionId = parsed.sessionId;

  // Taken before the ledger read, exactly as the direct hooks do: a hook that
  // is mid-upload for this session has already read these totals, and a second
  // reader would compute an overlapping delta.
  if (!acquireSessionLock(source, sessionId)) {
    return { status: 'locked', sessionId };
  }

  try {
    // Before anything reads or writes this session's record: see
    // upgradeLineCountedTotals for why an unconverted one must not reach the
    // monotonic write below.
    if (source === 'claude_code') {
      upgradeLineCountedTotals(sessionId, (lineCounted) =>
        convertLineCountedWatermark(candidate.filePath, lineCounted)
      );
    }

    // Guardrail 2. `endedAt` comes from the file's own content, so a machine
    // whose clock jumped backwards cannot make a live session look stale and
    // get its tokens silently swallowed by the seed path. A future mtime counts
    // as recent for the same reason.
    const endedAtMs = Date.parse(parsed.endedAt ?? '');
    const isRecent =
      now - candidate.mtimeMs <= cutoffMs ||
      (Number.isFinite(endedAtMs) && now - endedAtMs <= cutoffMs);

    if (!isRecent) {
      markTotalsSeeded(source, sessionId, parsed);
      return { status: 'seeded', sessionId };
    }

    const alreadySent = getSentTotals(source, sessionId);
    const pieces = splitSessionDelta(parsed, alreadySent);
    if (pieces.length === 0) return { status: 'nodelta', sessionId };

    // Guardrail 4.
    const uploadCtx = await resolveUploadContextWithRefresh({ source, sessionId, cwd: parsed.cwd });
    if (!uploadCtx.ok) {
      return { status: /credential/.test(uploadCtx.reason) ? 'nocred' : 'noroute', sessionId };
    }
    const { apiBaseUrl, deviceId, token, route } = uploadCtx;

    const events = pieces.map((piece) =>
      buildUsageEvent(source, deviceId, sessionId, parsed.model, piece, alreadySent)
    );
    for (const event of events) assertNoForbiddenFields(event);

    const verdict = await uploader(apiBaseUrl, token, deviceId, events);
    if (verdict && !verdict.canAdvanceLedger) {
      return { status: 'error', sessionId, error: 'server rejected retriably' };
    }

    markTotalsSentMonotonic(source, sessionId, parsed, route.routeId);
    return {
      status: 'uploaded',
      sessionId,
      routeId: route.routeId,
      tokens: events.reduce((n, e) => n + e.total_tokens, 0),
    };
  } finally {
    releaseSessionLock(source, sessionId);
  }
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export async function runSweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const maxUploads = opts.maxUploads ?? SWEEP_MAX_UPLOADS_PER_RUN;
  const log = opts.log ?? (() => {});
  const exclude = opts.exclude ?? new Set();

  const report = {
    scanned: 0,
    parsed: 0,
    uploaded: 0,
    seeded: 0,
    tokens: 0,
    errors: 0,
    skipped: { cached: 0, locked: 0, nodelta: 0, noroute: 0, nocred: 0, toobig: 0, excluded: 0 },
    timedOut: false,
  };

  // Record homes that vanished so the registry can age them out — but only
  // after several consecutive misses (a network home can be transiently gone).
  const missing = [];
  for (const kind of ['codex', 'claude_code']) {
    for (const home of listAgentHomes(kind, { includeMissing: true })) {
      if (!existsSync(home.dir)) missing.push(normalizePath(home.dir));
    }
  }
  noteMissingHomes(missing);

  const candidates = [
    ...discoverCodexSessionFiles({ now, maxFiles: opts.maxFiles }),
    ...discoverClaudeTranscriptFiles({ now, maxFiles: opts.maxFiles }),
  ];
  report.scanned = candidates.length;

  const cache = loadScanCache();
  const seenSessions = new Set();

  for (const candidate of sortByMtimeDesc(candidates)) {
    if (Date.now() - started > budgetMs) {
      report.timedOut = true;
      break;
    }
    if (report.errors >= SWEEP_MAX_ERRORS) break;
    if (report.uploaded >= maxUploads) break;

    const key = `${candidate.source}:${candidate.sessionIdHint}`;
    if (exclude.has(key)) {
      report.skipped.excluded++;
      continue;
    }

    // An orchestrator may keep a backfilled copy of a whole session directory
    // next to the live one, so the same session shows up under two homes. We
    // are iterating newest-first, so the first copy seen is the live one and
    // the stale copy must not be processed at all — its older cumulative would
    // otherwise be written over the ledger. (markTotalsSentMonotonic is the
    // second line of defence for the same hazard.)
    if (seenSessions.has(key)) {
      report.skipped.cached++;
      continue;
    }

    if (isUnchanged(cache, candidate.filePath, candidate)) {
      const cached = getCacheEntry(cache, candidate.filePath);
      if (cached?.sid) seenSessions.add(`${candidate.source}:${cached.sid}`);
      seenSessions.add(key);
      report.skipped.cached++;
      continue;
    }

    let result;
    try {
      result = await sweepOneSession(candidate, { now, uploader: opts.uploader, cutoffMs: opts.cutoffMs });
    } catch (err) {
      report.errors++;
      log(`sweep: ${candidate.source} session failed: ${err.message}`);
      continue;
    }

    report.parsed++;
    if (result.sessionId) {
      seenSessions.add(`${candidate.source}:${result.sessionId}`);
      seenSessions.add(key);
    }

    switch (result.status) {
      case 'uploaded':
        report.uploaded++;
        report.tokens += result.tokens ?? 0;
        rememberScan(cache, candidate.filePath, candidate, { sid: result.sessionId, now });
        break;
      case 'seeded':
        report.seeded++;
        rememberScan(cache, candidate.filePath, candidate, { sid: result.sessionId, now });
        break;
      case 'error':
        report.errors++;
        // Deliberately NOT remembered: the next run must re-parse and retry.
        break;
      case 'locked':
        report.skipped.locked++;
        break;
      default:
        report.skipped[result.status] = (report.skipped[result.status] ?? 0) + 1;
        rememberScan(cache, candidate.filePath, candidate, { sid: result.sessionId, now });
    }
  }

  saveScanCache(cache, { now });
  report.durationMs = Date.now() - started;
  return report;
}

// ─── Call-site helper ─────────────────────────────────────────────────────────

/**
 * The one line a hook calls. Cheap enough for the interactive path: a config
 * read, a throttle read, then a detached spawn — the same shape claude's
 * session-end hook already uses to launch its worker. The sweep must never run
 * inline; Codex hooks are capped at 10-30s and Claude's at 10s.
 */
export function maybeSpawnSweep(opts = {}, env = process.env) {
  try {
    if (env.AGENTBOARD_INTERNAL === '1') return false;
    if (env.AGENTBOARD_SWEEP === 'off') return false;
    if (!shouldSweep({ force: opts.force })) return false;

    const args = [fileURLToPath(new URL('../sweep/run.mjs', import.meta.url))];
    if (opts.force) args.push('--force');
    if (opts.source && opts.sessionId) args.push('--exclude', `${opts.source}:${opts.sessionId}`);

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...env },
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    // A sweep that cannot start must never take the hook down with it.
    return false;
  }
}
