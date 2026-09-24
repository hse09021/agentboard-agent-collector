/**
 * Codex CLI session JSONL parser for hook scripts.
 *
 * Privacy: only reads token_count event payloads and model names.
 * Never accesses text content of conversation turns.
 *
 * Session files live at: <codex home>/sessions/YYYY/MM/DD/{sessionId}.jsonl
 *
 * A thread is not always one file. Codex can move a live thread onto a new
 * rollout, `rollout-<ts>-{sessionId}_{pageId}.jsonl`, whose session_meta still
 * names the thread; its own state db then points the thread at the new file.
 * Each page holds only the API calls made while it was current, so the thread's
 * usage is the sum of its pages. Reading the first page alone left every later
 * turn uncollected by notify, and the sweep then diffed a later page against
 * the first page's watermark.
 *
 * The home is NOT always ~/.codex. Codex honours CODEX_HOME, and agent
 * orchestrators use it: Orca runs Codex with CODEX_HOME pointed at its own
 * runtime home, so the rollouts land there and nowhere near ~/.codex. Resolving
 * this against homedir() alone was why Codex usage went uncollected inside
 * Orca — see lib/agent-homes.mjs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getCodexSessionsDirs } from '../lib/agent-homes.mjs';
import { addToDayBucket, sortDayBuckets } from '../lib/daily-split.mjs';

function toNN(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toIso(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The thread's first page ends in `-{id}.jsonl`, a later page in
// `-{id}_{pageId}.jsonl`. Anchored on the character before the id, so asking
// for a page id never matches the page it names.
function threadFilePattern(sessionId) {
  return new RegExp(`(?:^|-)${escapeRegExp(String(sessionId))}(?:_.+)?\\.jsonl$`);
}

function collectDir(dir, pattern, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) collectDir(fullPath, pattern, out);
    else if (entry.isFile() && pattern.test(entry.name)) out.push(fullPath);
  }
  return out;
}

/**
 * Locate every page of a thread's rollout, oldest first.
 *
 * Homes are searched most-specific first, and the first home holding any page
 * wins outright: an orchestrator can keep a backfilled copy of ~/.codex next to
 * its own home, and mixing pages from both would count the copy twice. A hook
 * running inside an orchestrator-launched Codex therefore matches in its own
 * CODEX_HOME and never walks ~/.codex at all.
 *
 * Returns [] when no home holds a file for this id. That is the honest answer,
 * and callers must treat it as such — the previous behaviour, falling back to
 * "the newest rollout anywhere", handed the caller a stranger's session whose
 * tokens then got charged against the wrong ledger entry and routed to
 * whichever server that other session belonged to.
 *
 * @param {string} sessionId - the thread id
 * @param {{dirs?: string[]}} [opts] - sessions dirs to search instead of every
 *   known home; the sweep passes the one its candidate was found in
 */
export function findCodexSessionFiles(sessionId, opts = {}) {
  const pattern = threadFilePattern(sessionId);
  for (const sessionsDir of opts.dirs ?? getCodexSessionsDirs()) {
    const found = collectDir(sessionsDir, pattern, []);
    // Names start with the page's creation time, so name order is page order.
    if (found.length > 0) {
      return found.sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0));
    }
  }
  return [];
}

function parseUsageObject(usageObj) {
  if (!usageObj || typeof usageObj !== 'object') return null;
  return {
    input_tokens: toNN(usageObj.input_tokens ?? usageObj.prompt_tokens),
    output_tokens: toNN(usageObj.output_tokens ?? usageObj.completion_tokens),
    cache_read_tokens: toNN(
      usageObj.cached_input_tokens ??
      usageObj.cache_read_input_tokens ??
      usageObj.cache_read_tokens ??
      usageObj.cached_tokens ??
      0
    ),
  };
}

/**
 * Read one rollout file: its metadata, plus one entry per API call, in file
 * order. Consecutive repeats of the same usage are one call reported twice.
 */
function readRollout(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  let model;
  let sessionId;
  // Routing anchor. Codex's per-turn `notify` payload carries only
  // {thread-id, status}, so the working directory has to come from the rollout
  // file. Read here and used only to pick a destination server — never uploaded.
  let cwd;
  let startedAt;
  let endedAt;
  let previousTotalUsage = null;
  let lastTokenUsageKey = null;
  let lastSeenTs;
  const calls = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = toIso(entry.timestamp);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
      lastSeenTs = ts;
    }

    const type = entry.type;
    const payload =
      entry.payload && typeof entry.payload === 'object' ? entry.payload : {};

    if (type === 'session_meta' || type === 'turn_context') {
      if (type === 'session_meta' && payload.id && !sessionId) {
        sessionId = String(payload.id);
      }
      if (type === 'session_meta' && payload.cwd && !cwd) {
        cwd = String(payload.cwd);
      }
      if (payload.model && !model) model = String(payload.model);
      continue;
    }

    if (type !== 'event_msg' || payload.type !== 'token_count') continue;

    const info =
      payload.info && typeof payload.info === 'object' ? payload.info : {};
    const lastTokenUsage =
      info.last_token_usage && typeof info.last_token_usage === 'object'
        ? info.last_token_usage
        : null;
    const totalTokenUsage =
      info.total_token_usage && typeof info.total_token_usage === 'object'
        ? info.total_token_usage
        : null;

    const usageSource = lastTokenUsage || totalTokenUsage;
    if (!usageSource) continue;

    const key = JSON.stringify(usageSource);
    if (key === lastTokenUsageKey) continue;
    lastTokenUsageKey = key;

    let usage;
    if (lastTokenUsage) {
      usage = parseUsageObject(lastTokenUsage);
    } else {
      const curr = parseUsageObject(totalTokenUsage);
      if (curr && previousTotalUsage) {
        const prev = parseUsageObject(previousTotalUsage);
        usage = {
          input_tokens: Math.max(0, curr.input_tokens - prev.input_tokens),
          output_tokens: Math.max(0, curr.output_tokens - prev.output_tokens),
          cache_read_tokens: Math.max(0, curr.cache_read_tokens - prev.cache_read_tokens),
        };
      } else {
        usage = curr;
      }
    }

    if (totalTokenUsage) previousTotalUsage = totalTokenUsage;
    if (!usage) continue;

    // Codex reports input_tokens INCLUDING the cached part, so the uncached
    // share is clamped per turn rather than once over the whole session — the
    // day buckets must sum to the session totals for the delta split to work,
    // and a per-turn clamp is the stricter, more accurate reading anyway.
    const uncachedInput = Math.max(0, usage.input_tokens - usage.cache_read_tokens);
    calls.push({
      // An entry without its own timestamp falls back to the last one seen, so
      // it lands on the day it was actually written rather than being dropped.
      ts: ts ?? lastSeenTs ?? startedAt ?? new Date().toISOString(),
      rawInputTokens: usage.input_tokens,
      turn: {
        inputTokens: uncachedInput,
        outputTokens: usage.output_tokens,
        cacheCreationTokens: 0,
        cacheReadTokens: usage.cache_read_tokens,
        totalTokens: uncachedInput + usage.output_tokens + usage.cache_read_tokens,
      },
    });
  }

  return { model, sessionId, cwd, startedAt, endedAt, calls };
}

/**
 * Parse the pages of one thread (see findCodexSessionFiles), oldest first, and
 * return the thread's aggregated usage, or null if it has none.
 *
 * A page counts only if its session_meta names the same thread as the first
 * page's. The file name is what put it in the list; the session_meta is Codex's
 * own statement of which thread the file belongs to.
 *
 * @param {string[]} filePaths - absolute paths to the thread's .jsonl pages
 */
export function parseCodexFiles(filePaths) {
  const rollouts = filePaths.map(readRollout).filter(Boolean);
  const threadId = rollouts.find((r) => r.sessionId)?.sessionId;
  const pages = rollouts.filter((r) => !r.sessionId || r.sessionId === threadId);
  if (pages.length === 0) return null;

  let rawInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let model;
  let cwd;
  let startedAt;
  let endedAt;
  // Per-day buckets so a thread resumed on a later day reports that day's
  // tokens under that day, not under the thread's creation date.
  const dayBuckets = new Map();

  for (const page of pages) {
    if (!model && page.model) model = page.model;
    if (!cwd && page.cwd) cwd = page.cwd;
    if (page.startedAt && (!startedAt || page.startedAt < startedAt)) startedAt = page.startedAt;
    if (page.endedAt && (!endedAt || page.endedAt > endedAt)) endedAt = page.endedAt;

    for (const call of page.calls) {
      rawInputTokens += call.rawInputTokens;
      inputTokens += call.turn.inputTokens;
      outputTokens += call.turn.outputTokens;
      cacheReadTokens += call.turn.cacheReadTokens;
      addToDayBucket(dayBuckets, call.ts, call.turn);
    }
  }

  const rawTotal = rawInputTokens + outputTokens + cacheReadTokens;
  if (rawTotal === 0) return null;

  const totalTokens = inputTokens + outputTokens + cacheReadTokens;

  return {
    sessionId: threadId,
    cwd,
    model: model ?? 'codex',
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt: endedAt ?? new Date().toISOString(),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    byDate: sortDayBuckets(dayBuckets),
  };
}

/**
 * Parse a single Codex rollout file. A subagent's rollout, or a test fixture;
 * a thread seen by id goes through parseCodexSession, which reads every page.
 * @param {string} filePath - Absolute path to the .jsonl session file
 */
export function parseCodexFile(filePath) {
  return parseCodexFiles([filePath]);
}

/**
 * Parse every page of a Codex thread and return its aggregated usage.
 * @param {string} sessionId - The Codex session / thread ID
 */
export function parseCodexSession(sessionId) {
  const filePaths = findCodexSessionFiles(sessionId);
  if (filePaths.length === 0) return null;
  return parseCodexFiles(filePaths);
}
