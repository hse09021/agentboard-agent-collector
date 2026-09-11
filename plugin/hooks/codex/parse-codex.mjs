/**
 * Codex CLI session JSONL parser for hook scripts.
 *
 * Privacy: only reads token_count event payloads and model names.
 * Never accesses text content of conversation turns.
 *
 * Session files live at: <codex home>/sessions/YYYY/MM/DD/{sessionId}.jsonl
 *
 * The home is NOT always ~/.codex. Codex honours CODEX_HOME, and agent
 * orchestrators use it: Orca runs Codex with CODEX_HOME pointed at its own
 * runtime home, so the rollouts land there and nowhere near ~/.codex. Resolving
 * this against homedir() alone was why Codex usage went uncollected inside
 * Orca — see lib/agent-homes.mjs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

function searchDir(dir, sessionId) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = searchDir(fullPath, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Locate a rollout by session id across every Codex home this machine has.
 *
 * Searched most-specific first, so a hook running inside an orchestrator-
 * launched Codex matches in its own CODEX_HOME on the first directory and
 * never walks ~/.codex at all.
 *
 * Returns null when no home holds a file for this id. That is the honest
 * answer, and callers must treat it as such — the previous behaviour, falling
 * back to "the newest rollout anywhere", handed the caller a stranger's session
 * whose tokens then got charged against the wrong ledger entry and routed to
 * whichever server that other session belonged to.
 */
export function findCodexSessionFile(sessionId) {
  for (const sessionsDir of getCodexSessionsDirs()) {
    const found = searchDir(sessionsDir, sessionId);
    if (found) return found;
  }
  return null;
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
 * Parse a Codex CLI session JSONL file and return aggregated usage.
 * Exported for direct use in tests.
 * @param {string} filePath - Absolute path to the .jsonl session file
 */
export function parseCodexFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  let rawInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
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
  // Per-day buckets so a thread resumed on a later day reports that day's
  // tokens under that day, not under the thread's creation date.
  const dayBuckets = new Map();
  let lastSeenTs;

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
    const turn = {
      inputTokens: uncachedInput,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: 0,
      cacheReadTokens: usage.cache_read_tokens,
      totalTokens: uncachedInput + usage.output_tokens + usage.cache_read_tokens,
    };

    rawInputTokens += usage.input_tokens;
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    cacheReadTokens += turn.cacheReadTokens;

    // An entry without its own timestamp falls back to the last one seen, so it
    // lands on the day it was actually written rather than being dropped.
    addToDayBucket(dayBuckets, ts ?? lastSeenTs ?? startedAt ?? new Date().toISOString(), turn);
  }

  const rawTotal = rawInputTokens + outputTokens + cacheReadTokens;
  if (rawTotal === 0) return null;

  const totalTokens = inputTokens + outputTokens + cacheReadTokens;

  return {
    sessionId,
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
 * Parse a Codex CLI session JSONL file and return aggregated usage.
 * @param {string} sessionId - The Codex session / thread ID
 */
export function parseCodexSession(sessionId) {
  const filePath = findCodexSessionFile(sessionId);
  if (!filePath) return null;
  return parseCodexFile(filePath);
}
