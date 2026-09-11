/**
 * Claude Code JSONL session parser for hook scripts.
 *
 * Privacy: reads only message.usage and message.model from assistant entries
 * with a stop_reason. The message.content field is never accessed.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addToDayBucket,
  sortDayBuckets,
  mergeDayBuckets,
} from '../lib/daily-split.mjs';

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

function parseSingleFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheCreation5mTokens = 0;
  let cacheCreation1hTokens = 0;
  let cacheReadTokens = 0;
  let model;
  let startedAt;
  let endedAt;
  // Routing anchor. The hook payload carries `cwd` for the live session, but a
  // session discovered by the cross-agent sweep has no payload — so the working
  // directory has to come from the transcript itself. Read only to pick a
  // destination server; never uploaded.
  let cwd;
  // Per-day buckets so a session resumed on a later day reports that day's
  // tokens under that day, not under the session's creation date.
  const dayBuckets = new Map();
  let lastSeenTs;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Present on user/assistant entries (not on the leading operation entry).
    if (!cwd && typeof parsed.cwd === 'string' && parsed.cwd) cwd = parsed.cwd;

    const ts = toIso(parsed.timestamp);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
      lastSeenTs = ts;
    }

    if (parsed.type !== 'assistant') continue;
    const msg = parsed.message;
    if (!msg || typeof msg !== 'object') continue;

    const msgModel = typeof msg.model === 'string' ? msg.model : '';
    if (!msgModel || msgModel === '<synthetic>') continue;
    if (!msg.stop_reason) continue;

    model = msgModel;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') continue;

    // Anthropic bills the two cache-write TTLs at different multiples of the
    // input price (5-minute writes at 1.25x, 1-hour at 2x), and reports the
    // split under `usage.cache_creation`. Collapsing them into one number is
    // why cache-heavy sessions could not be costed correctly. These are a
    // BREAKDOWN of cacheCreationTokens — never added to the total.
    const cacheCreation =
      usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};

    const turn = {
      inputTokens: toNN(usage.input_tokens),
      outputTokens: toNN(usage.output_tokens),
      cacheCreationTokens: toNN(usage.cache_creation_input_tokens),
      cacheCreation5mTokens: toNN(cacheCreation.ephemeral_5m_input_tokens),
      cacheCreation1hTokens: toNN(cacheCreation.ephemeral_1h_input_tokens),
      cacheReadTokens: toNN(usage.cache_read_input_tokens),
    };
    turn.totalTokens =
      turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;

    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    cacheCreationTokens += turn.cacheCreationTokens;
    cacheCreation5mTokens += turn.cacheCreation5mTokens;
    cacheCreation1hTokens += turn.cacheCreation1hTokens;
    cacheReadTokens += turn.cacheReadTokens;

    // An entry without its own timestamp falls back to the last one seen, so it
    // lands on the day it was actually written rather than being dropped.
    addToDayBucket(dayBuckets, ts ?? lastSeenTs ?? startedAt ?? new Date().toISOString(), turn);
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheReadTokens,
    model,
    cwd,
    startedAt,
    endedAt,
    byDate: sortDayBuckets(dayBuckets),
  };
}

/**
 * Parse a Claude Code session JSONL file (+ subagent files).
 * Returns aggregated token counts or null if nothing found.
 */
export function parseClaudeSession(transcriptPath) {
  const filePaths = [transcriptPath];

  const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
  const subagentsDir = join(sessionDir, 'subagents');
  if (existsSync(subagentsDir)) {
    try {
      readdirSync(subagentsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .forEach((f) => filePaths.push(join(subagentsDir, f)));
    } catch { /* ignore */ }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheCreation5mTokens = 0;
  let cacheCreation1hTokens = 0;
  let cacheReadTokens = 0;
  let model;
  let cwd;
  let startedAt;
  let endedAt;
  let hasAny = false;
  let byDate = [];

  for (const p of filePaths) {
    const r = parseSingleFile(p);
    if (!r) continue;
    hasAny = true;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheCreationTokens += r.cacheCreationTokens;
    cacheCreation5mTokens += r.cacheCreation5mTokens;
    cacheCreation1hTokens += r.cacheCreation1hTokens;
    cacheReadTokens += r.cacheReadTokens;
    if (!model && r.model) model = r.model;
    // filePaths[0] is the parent transcript, so first-wins takes the parent's
    // cwd. A subagent can run somewhere else entirely, and the session belongs
    // to where the parent was working.
    if (!cwd && r.cwd) cwd = r.cwd;
    if (r.startedAt && (!startedAt || r.startedAt < startedAt)) startedAt = r.startedAt;
    if (r.endedAt && (!endedAt || r.endedAt > endedAt)) endedAt = r.endedAt;
    // A subagent's tokens belong to the day they ran on, same as the parent's.
    byDate = mergeDayBuckets(byDate, r.byDate);
  }

  if (!hasAny) return null;

  const totalTokens = inputTokens + cacheCreationTokens + outputTokens + cacheReadTokens;
  if (totalTokens === 0) return null;

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheReadTokens,
    totalTokens,
    model,
    cwd,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
    byDate,
  };
}
