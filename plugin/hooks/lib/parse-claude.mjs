/**
 * Claude Code JSONL session parser for hook scripts.
 *
 * Privacy: reads only message.usage and message.model from assistant entries
 * with a stop_reason. The message.content field is never accessed.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  let cacheReadTokens = 0;
  let model;
  let startedAt;
  let endedAt;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = toIso(parsed.timestamp);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
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

    inputTokens += toNN(usage.input_tokens);
    outputTokens += toNN(usage.output_tokens);
    cacheCreationTokens += toNN(usage.cache_creation_input_tokens);
    cacheReadTokens += toNN(usage.cache_read_input_tokens);
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model, startedAt, endedAt };
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
  let cacheReadTokens = 0;
  let model;
  let startedAt;
  let endedAt;
  let hasAny = false;

  for (const p of filePaths) {
    const r = parseSingleFile(p);
    if (!r) continue;
    hasAny = true;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheCreationTokens += r.cacheCreationTokens;
    cacheReadTokens += r.cacheReadTokens;
    if (!model && r.model) model = r.model;
    if (r.startedAt && (!startedAt || r.startedAt < startedAt)) startedAt = r.startedAt;
    if (r.endedAt && (!endedAt || r.endedAt > endedAt)) endedAt = r.endedAt;
  }

  if (!hasAny) return null;

  const cachedTokens = cacheReadTokens;
  const totalTokens = inputTokens + cacheCreationTokens + outputTokens + cachedTokens;
  if (totalTokens === 0) return null;

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cachedTokens,
    totalTokens,
    model,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
  };
}
