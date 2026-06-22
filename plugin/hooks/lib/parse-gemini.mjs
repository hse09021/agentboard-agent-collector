/**
 * Gemini CLI session JSON parser for hook scripts.
 *
 * Privacy: reads only type, metadata.tokenCount.* fields.
 * Never accesses conversation content.
 *
 * Session files live at:
 *   ~/.gemini/tmp/{checksum}/chats/session-{sessionId}.json
 */

import { existsSync, readFileSync } from 'node:fs';

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

/**
 * Parse a Gemini CLI session JSON file.
 * @param {string} filePath - Absolute path to the session .json file
 */
export function parseGeminiSession(filePath) {
  if (!existsSync(filePath)) return null;

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const messages = Array.isArray(data)
    ? data
    : (data.history ?? data.messages ?? data.turns ?? []);

  if (!Array.isArray(messages) || messages.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thoughtsTokens = 0;
  let model;
  let startedAt;
  let endedAt;
  let hasAny = false;

  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type !== 'gemini' && entry.role !== 'model') continue;

    const ts = toIso(entry.timestamp ?? entry.ts ?? entry.createdAt ?? entry.created_at);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }

    const meta = entry.metadata ?? entry.usageMetadata ?? entry.usage_metadata;
    if (!meta || typeof meta !== 'object') continue;

    hasAny = true;

    if (!model) {
      model =
        entry.model ??
        meta.model ??
        (typeof data.model === 'string' ? data.model : undefined);
    }

    const tokenCount = meta.tokenCount ?? meta.token_count ?? meta;
    const rawInput = toNN(
      tokenCount.inputTokenCount ??
        tokenCount.input_token_count ??
        tokenCount.promptTokenCount ??
        tokenCount.prompt_token_count
    );
    const rawOutput = toNN(
      tokenCount.outputTokenCount ??
        tokenCount.output_token_count ??
        tokenCount.candidatesTokenCount ??
        tokenCount.candidates_token_count
    );
    const cached = toNN(
      tokenCount.cachedContentTokenCount ??
        tokenCount.cached_content_token_count ??
        tokenCount.cacheTokenCount ??
        tokenCount.cache_token_count
    );
    const thoughts = toNN(
      tokenCount.thoughtsTokenCount ??
        tokenCount.thoughts_token_count ??
        tokenCount.thinkingTokenCount ??
        tokenCount.thinking_token_count
    );

    inputTokens += rawInput - cached;
    outputTokens += rawOutput + thoughts;
    cacheReadTokens += cached;
    thoughtsTokens += thoughts;
  }

  if (!hasAny) return null;

  const totalTokens = inputTokens + outputTokens + cacheReadTokens;
  if (totalTokens <= 0) return null;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    model,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
  };
}
