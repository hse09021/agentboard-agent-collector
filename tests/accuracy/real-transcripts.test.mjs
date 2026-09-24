/**
 * Accuracy check against the transcripts actually on this machine.
 *
 * The unit tests pin the parsers to hand-written fixtures, which only proves
 * the parsers agree with what the fixtures assume the files look like. This
 * compares each parser with an independent reading of the real files, done
 * the way the provider bills:
 *
 *   - Claude Code: every API response counted exactly once, keyed by message
 *     id + request id, under the same inclusion rules as the parser (real
 *     model, stop_reason present).
 *   - Codex: the rollout's own running counter (`total_token_usage`) on its
 *     last token_count event, minus what the file started with — a paginated
 *     continuation file inherits its thread's counter from the earlier page.
 *
 * Opt-in, because it reads this machine's transcripts and CI has none:
 *
 *   AGENTBOARD_ACCURACY=1 npx vitest run tests/accuracy
 *
 * Privacy: reads only usage counters, model names and ids, exactly what the
 * parsers read; reports session ids and counts only.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeSession } from '../../plugin/hooks/claude/parse-claude.mjs';
import { parseCodexFile } from '../../plugin/hooks/codex/parse-codex.mjs';
import {
  discoverClaudeTranscriptFiles,
  discoverCodexSessionFiles,
} from '../../plugin/hooks/lib/sweep.mjs';

const ENABLED = process.env.AGENTBOARD_ACCURACY === '1';
const EVERYTHING = { horizonMs: Infinity, maxFiles: Infinity };

function* jsonlEntries(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch { /* partial trailing line of a live session */ }
  }
}

function claudeSessionFiles(transcriptPath) {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const subagents = existsSync(subagentsDir)
    ? readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl')).map((f) => join(subagentsDir, f))
    : [];
  return [transcriptPath, ...subagents];
}

// A session still being written can change between the parser's read and the
// reference's read. Such a session is skipped rather than reported as a
// mismatch, so this test never flakes on the session that is running it.
function lastModified(files) {
  return Math.max(...files.map((f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  }));
}

const nn = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function claudeReference(transcriptPath) {
  const responses = new Map();
  for (const filePath of claudeSessionFiles(transcriptPath)) {
    let line = 0;
    for (const entry of jsonlEntries(filePath)) {
      line++;
      if (entry.type !== 'assistant') continue;
      const msg = entry.message;
      if (!msg || typeof msg !== 'object' || !msg.usage) continue;
      if (!msg.model || msg.model === '<synthetic>' || !msg.stop_reason) continue;
      // Entries with no message id (very old transcripts) cannot be grouped,
      // so each stands alone.
      const key = msg.id ? `${msg.id}:${entry.requestId ?? ''}` : `${filePath}:${line}`;
      responses.set(key, msg.usage);
    }
  }

  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const usage of responses.values()) {
    totals.inputTokens += nn(usage.input_tokens);
    totals.outputTokens += nn(usage.output_tokens);
    totals.cacheCreationTokens += nn(usage.cache_creation_input_tokens);
    totals.cacheReadTokens += nn(usage.cache_read_input_tokens);
  }
  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  return totals;
}

function codexReference(filePath) {
  const billed = (u) => nn(u?.input_tokens) + nn(u?.output_tokens);
  let first = null;
  let last = null;
  for (const entry of jsonlEntries(filePath)) {
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
    const info = entry.payload.info;
    if (!info?.total_token_usage) continue;
    first ??= info;
    last = info;
  }
  if (!last) return { totalTokens: 0 };
  const inherited =
    billed(first.total_token_usage) - billed(first.last_token_usage ?? first.total_token_usage);
  return { totalTokens: billed(last.total_token_usage) - inherited };
}

function summarize(rows, fields) {
  const mismatched = rows.filter((r) => fields.some((f) => r.collector[f] !== r.reference[f]));
  const sum = (side) => rows.reduce((n, r) => n + r[side].totalTokens, 0);
  const collector = sum('collector');
  const reference = sum('reference');
  const worst = [...mismatched]
    .sort(
      (a, b) =>
        Math.abs(b.collector.totalTokens - b.reference.totalTokens) -
        Math.abs(a.collector.totalTokens - a.reference.totalTokens)
    )
    .slice(0, 10)
    .map((r) => ({
      session: r.session,
      collector: r.collector.totalTokens,
      reference: r.reference.totalTokens,
      ratio: r.reference.totalTokens ? +(r.collector.totalTokens / r.reference.totalTokens).toFixed(3) : null,
    }));
  return {
    sessions: rows.length,
    mismatched: mismatched.length,
    collector,
    reference,
    ratio: reference ? +(collector / reference).toFixed(4) : null,
    worst,
  };
}

describe.skipIf(!ENABLED)('token accuracy against this machine’s real transcripts', () => {
  it('Claude Code: the parser matches one count per API response', () => {
    const fields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens'];
    const rows = [];
    for (const candidate of discoverClaudeTranscriptFiles(EVERYTHING)) {
      const files = claudeSessionFiles(candidate.filePath);
      const before = lastModified(files);
      const parsed = parseClaudeSession(candidate.filePath);
      const reference = claudeReference(candidate.filePath);
      if (lastModified(files) !== before) continue;

      const collector = Object.fromEntries(fields.map((f) => [f, parsed?.[f] ?? 0]));
      if (collector.totalTokens === 0 && reference.totalTokens === 0) continue;
      rows.push({ session: candidate.sessionIdHint, collector, reference });
    }

    const summary = summarize(rows, fields);
    console.log('[accuracy] claude_code', JSON.stringify(summary, null, 2));
    expect(summary.mismatched, JSON.stringify(summary, null, 2)).toBe(0);
  });

  it('Codex: the parser matches the rollout’s own token counter', () => {
    const rows = [];
    for (const candidate of discoverCodexSessionFiles(EVERYTHING)) {
      const before = lastModified([candidate.filePath]);
      const parsed = parseCodexFile(candidate.filePath);
      const reference = codexReference(candidate.filePath);
      if (lastModified([candidate.filePath]) !== before) continue;

      const collector = { totalTokens: parsed?.totalTokens ?? 0 };
      if (collector.totalTokens === 0 && reference.totalTokens === 0) continue;
      rows.push({ session: candidate.sessionIdHint, collector, reference });
    }

    const summary = summarize(rows, ['totalTokens']);
    console.log('[accuracy] codex', JSON.stringify(summary, null, 2));
    expect(summary.mismatched, JSON.stringify(summary, null, 2)).toBe(0);
  });
});
