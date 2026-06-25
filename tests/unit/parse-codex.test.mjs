/**
 * Tests for plugin/hooks/lib/parse-codex.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexFile } from '../../plugin/hooks/lib/parse-codex.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentboard-codex-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpJsonl(name, lines) {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function sessionMeta(model = 'gpt-4o') {
  return { type: 'session_meta', timestamp: '2024-06-01T10:00:00.000Z', payload: { model } };
}

function tokenCountEvent(lastUsage, ts = '2024-06-01T10:01:00.000Z') {
  return {
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: { last_token_usage: lastUsage },
    },
  };
}

function tokenCountCumulative(totalUsage, ts = '2024-06-01T10:01:00.000Z') {
  return {
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: { total_token_usage: totalUsage },
    },
  };
}

describe('parseCodexFile — basic token counting', () => {
  it('parses a single turn with no caching', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }),
    ]);
    const result = parseCodexFile(file);
    expect(result).not.toBeNull();
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.totalTokens).toBe(150);
  });

  it('accumulates tokens across multiple turns', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 100, output_tokens: 40 }, '2024-06-01T10:01:00.000Z'),
      tokenCountEvent({ input_tokens: 200, output_tokens: 60 }, '2024-06-01T10:02:00.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(100);
    expect(result.totalTokens).toBe(400);
  });

  it('returns null for an empty file', () => {
    const file = writeTmpJsonl('empty.jsonl', []);
    expect(parseCodexFile(file)).toBeNull();
  });

  it('returns null when all token counts are zero', () => {
    const file = writeTmpJsonl('zero.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 0, output_tokens: 0 }),
    ]);
    expect(parseCodexFile(file)).toBeNull();
  });

  it('returns null for a non-existent file path', () => {
    expect(parseCodexFile(join(tmpDir, 'does-not-exist.jsonl'))).toBeNull();
  });
});

describe('parseCodexFile — cached_input_tokens field', () => {
  it('reads cached_input_tokens', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 300, output_tokens: 80, cached_input_tokens: 200 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.cacheReadTokens).toBe(200);
  });

  it('also accepts cache_read_input_tokens as a fallback', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 150 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.cacheReadTokens).toBe(150);
  });

  it('also accepts cached_tokens as a fallback', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 300, output_tokens: 80, cached_tokens: 100 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.cacheReadTokens).toBe(100);
  });

  it('cached_input_tokens wins over other field names', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({
        input_tokens: 300,
        output_tokens: 80,
        cached_input_tokens: 200,
        cached_tokens: 99,
      }),
    ]);
    const result = parseCodexFile(file);
    expect(result.cacheReadTokens).toBe(200);
  });
});

describe('parseCodexFile — no double-counting of cached tokens', () => {
  it('inputTokens is the non-cached portion (input - cached)', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 300, output_tokens: 80, cached_input_tokens: 200 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.inputTokens).toBe(100);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
  });

  it('totalTokens equals raw API total (input_tokens + output_tokens)', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 300, output_tokens: 80, cached_input_tokens: 200 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.totalTokens).toBe(300 + 80);
  });

  it('totalTokens = inputTokens + outputTokens + cacheReadTokens', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 400, output_tokens: 100, cached_input_tokens: 150 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.totalTokens).toBe(result.inputTokens + result.outputTokens + result.cacheReadTokens);
  });

  it('handles the case where all input is cached', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 500, output_tokens: 60, cached_input_tokens: 500 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.inputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(500);
    expect(result.totalTokens).toBe(560);
  });

  it('handles multi-turn accumulation with caching', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 200, output_tokens: 40, cached_input_tokens: 100 }, '2024-06-01T10:01:00.000Z'),
      tokenCountEvent({ input_tokens: 300, output_tokens: 60, cached_input_tokens: 150 }, '2024-06-01T10:02:00.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.inputTokens).toBe(250);
    expect(result.cacheReadTokens).toBe(250);
    expect(result.outputTokens).toBe(100);
    expect(result.totalTokens).toBe(600);
  });
});

describe('parseCodexFile — cumulative total_token_usage (delta path)', () => {
  it('computes per-turn delta from cumulative totals', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountCumulative({ input_tokens: 100, output_tokens: 40 }, '2024-06-01T10:01:00.000Z'),
      tokenCountCumulative({ input_tokens: 250, output_tokens: 90 }, '2024-06-01T10:02:00.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.outputTokens).toBe(90);
    expect(result.totalTokens).toBe(250 + 90);
  });

  it('uses cumulative total directly when no previous total exists', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountCumulative({ input_tokens: 200, output_tokens: 70 }),
    ]);
    const result = parseCodexFile(file);
    expect(result.outputTokens).toBe(70);
    expect(result.totalTokens).toBe(200 + 70);
  });
});

describe('parseCodexFile — deduplication of consecutive identical events', () => {
  it('skips duplicate consecutive token_count events', () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent(usage, '2024-06-01T10:01:00.000Z'),
      tokenCountEvent(usage, '2024-06-01T10:01:01.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('does NOT skip non-consecutive events with same values', () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent(usage, '2024-06-01T10:01:00.000Z'),
      tokenCountEvent({ input_tokens: 200, output_tokens: 80 }, '2024-06-01T10:02:00.000Z'),
      tokenCountEvent(usage, '2024-06-01T10:03:00.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.outputTokens).toBe(50 + 80 + 50);
  });
});

describe('parseCodexFile — model extraction', () => {
  it('extracts session id from session_meta', () => {
    const file = writeTmpJsonl('session.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2024-06-01T10:00:00.000Z',
        payload: { id: '019eff03-e4ce-70c2-9104-2d8b7aef208c', model: 'gpt-5.5' },
      },
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(parseCodexFile(file).sessionId).toBe('019eff03-e4ce-70c2-9104-2d8b7aef208c');
  });

  it('extracts model from session_meta', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta('gpt-4o-mini'),
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(parseCodexFile(file).model).toBe('gpt-4o-mini');
  });

  it('extracts model from turn_context when session_meta is absent', () => {
    const file = writeTmpJsonl('session.jsonl', [
      { type: 'turn_context', timestamp: '2024-06-01T10:00:00.000Z', payload: { model: 'o1-mini' } },
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(parseCodexFile(file).model).toBe('o1-mini');
  });

  it('falls back to "codex" when no model is found', () => {
    const file = writeTmpJsonl('session.jsonl', [
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(parseCodexFile(file).model).toBe('codex');
  });
});

describe('parseCodexFile — timestamps', () => {
  it('tracks startedAt and endedAt from event timestamps', () => {
    const file = writeTmpJsonl('session.jsonl', [
      sessionMeta(),
      tokenCountEvent({ input_tokens: 100, output_tokens: 50 }, '2024-06-01T10:05:00.000Z'),
      tokenCountEvent({ input_tokens: 80, output_tokens: 30 }, '2024-06-01T10:01:00.000Z'),
    ]);
    const result = parseCodexFile(file);
    expect(result.startedAt).toBe('2024-06-01T10:00:00.000Z');
    expect(result.endedAt).toBe('2024-06-01T10:05:00.000Z');
  });
});
