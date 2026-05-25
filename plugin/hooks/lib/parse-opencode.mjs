/**
 * OpenCode message-file session parser for hook scripts.
 *
 * Privacy: reads only role, tokens.* from message files.
 * Never accesses text content of messages.
 *
 * Session messages live at:
 *   $XDG_DATA_HOME/opencode/storage/message/{sessionId}/*.json
 * or
 *   ~/.local/share/opencode/storage/message/{sessionId}/*.json
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

function getDataHome() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return xdg.trim();
  return join(homedir(), '.local', 'share');
}

function getSessionDir(sessionId) {
  return join(getDataHome(), 'opencode', 'storage', 'message', sessionId);
}

/**
 * Parse an OpenCode session.
 * @param {string} sessionId - e.g. "ses_01jxyz..."
 */
export function parseOpenCodeSession(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!existsSync(sessionDir)) return null;

  let files;
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let model;
  let startedAt;
  let endedAt;
  let hasAny = false;

  for (const file of files) {
    let msg;
    try {
      msg = JSON.parse(readFileSync(join(sessionDir, file), 'utf-8'));
    } catch {
      continue;
    }

    if (msg.role !== 'assistant') continue;
    const tokens = msg.tokens;
    if (!tokens || typeof tokens !== 'object') continue;

    hasAny = true;

    if (!model && typeof msg.model === 'string' && msg.model.trim()) {
      model = msg.model.trim();
    }

    const cacheRead = toNN(tokens.cache?.read ?? tokens.cacheRead);
    const cacheWrite = toNN(tokens.cache?.write ?? tokens.cacheWrite);
    const rawInput = toNN(tokens.input ?? tokens.inputTokens);
    inputTokens += rawInput - cacheRead;
    outputTokens += toNN(tokens.output ?? tokens.outputTokens);
    cacheReadTokens += cacheRead;
    cacheCreationTokens += cacheWrite;

    const ts = msg.time?.created
      ? toIso(msg.time.created)
      : toIso(msg.createdAt ?? msg.created_at);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
  }

  if (!hasAny) return null;

  const cachedTokens = cacheReadTokens;
  const totalTokens = inputTokens + cacheCreationTokens + outputTokens + cachedTokens;
  if (totalTokens <= 0) return null;

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
