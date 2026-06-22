/**
 * Codex CLI session JSONL parser for hook scripts.
 *
 * Privacy: only reads token_count event payloads and model names.
 * Never accesses text content of conversation turns.
 *
 * Session files live at: ~/.codex/sessions/YYYY/MM/DD/{sessionId}.jsonl
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

function getCodexSessionsDir() {
  return join(homedir(), '.codex', 'sessions');
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

function findCodexSessionFile(sessionId) {
  const sessionsDir = getCodexSessionsDir();
  if (!existsSync(sessionsDir)) return null;
  return searchDir(sessionsDir, sessionId);
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

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let model;
  let startedAt;
  let endedAt;
  let previousTotalUsage = null;
  let lastTokenUsageKey = null;

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
    }

    const type = entry.type;
    const payload =
      entry.payload && typeof entry.payload === 'object' ? entry.payload : {};

    if (type === 'session_meta' || type === 'turn_context') {
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

    inputTokens += usage.input_tokens;
    outputTokens += usage.output_tokens;
    cacheReadTokens += usage.cache_read_tokens;
  }

  const rawTotal = inputTokens + outputTokens + cacheReadTokens;
  if (rawTotal === 0) return null;

  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  const totalTokens = uncachedInputTokens + outputTokens + cacheReadTokens;

  return {
    model: model ?? 'codex',
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt: endedAt ?? new Date().toISOString(),
    inputTokens: uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
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
