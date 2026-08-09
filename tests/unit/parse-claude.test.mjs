/**
 * Tests for plugin/hooks/claude/parse-claude.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseClaudeSession } from '../../plugin/hooks/claude/parse-claude.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentboard-claude-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpJsonl(name, lines) {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function makeAssistant(opts = {}) {
  return {
    type: 'assistant',
    timestamp: opts.timestamp ?? '2024-06-01T10:00:00.000Z',
    message: {
      model: opts.model ?? 'claude-3-5-sonnet-20241022',
      stop_reason: opts.stopReason ?? 'end_turn',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  };
}

describe('parseClaudeSession — basic token counting', () => {
  it('sums input and output tokens from a single assistant turn', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ inputTokens: 200, outputTokens: 80 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result).not.toBeNull();
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.totalTokens).toBe(280);
  });

  it('accumulates tokens across multiple turns', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ inputTokens: 100, outputTokens: 40 }),
      makeAssistant({ inputTokens: 150, outputTokens: 60, timestamp: '2024-06-01T10:01:00.000Z' }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(100);
    expect(result.totalTokens).toBe(350);
  });

  it('returns null for an empty file', () => {
    const file = writeTmpJsonl('empty.jsonl', []);
    expect(parseClaudeSession(file)).toBeNull();
  });

  it('returns null when all tokens are zero', () => {
    const file = writeTmpJsonl('zero.jsonl', [
      makeAssistant({ inputTokens: 0, outputTokens: 0 }),
    ]);
    expect(parseClaudeSession(file)).toBeNull();
  });
});

describe('parseClaudeSession — cache token routing', () => {
  it('cache_read_input_tokens go into cacheReadTokens', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ inputTokens: 50, outputTokens: 30, cacheRead: 200 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.inputTokens).toBe(50);
    expect(result.totalTokens).toBe(50 + 30 + 200);
  });

  it('cache_creation_input_tokens go into cacheCreationTokens', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ inputTokens: 50, outputTokens: 30, cacheCreation: 300 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.inputTokens).toBe(50);
    expect(result.cacheCreationTokens).toBe(300);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.totalTokens).toBe(50 + 300 + 30);
  });

  it('totalTokens equals inputTokens + cacheCreationTokens + outputTokens + cacheReadTokens', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ inputTokens: 80, outputTokens: 40, cacheCreation: 200, cacheRead: 100 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.totalTokens).toBe(
      result.inputTokens + result.cacheCreationTokens + result.outputTokens + result.cacheReadTokens
    );
  });
});

describe('parseClaudeSession — filtering rules', () => {
  it('skips entries without stop_reason', () => {
    const file = writeTmpJsonl('session.jsonl', [
      {
        type: 'assistant',
        timestamp: '2024-06-01T10:00:00.000Z',
        message: {
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 999, output_tokens: 999 },
        },
      },
      makeAssistant({ inputTokens: 100, outputTokens: 50 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('skips entries with model === "<synthetic>"', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ model: '<synthetic>', inputTokens: 9999, outputTokens: 9999 }),
      makeAssistant({ inputTokens: 100, outputTokens: 50 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('skips malformed JSON lines without crashing', () => {
    const filePath = join(tmpDir, 'malformed.jsonl');
    writeFileSync(
      filePath,
      'NOT_JSON\n' + JSON.stringify(makeAssistant({ inputTokens: 100, outputTokens: 50 })) + '\n'
    );
    const result = parseClaudeSession(filePath);
    expect(result.inputTokens).toBe(100);
  });
});

describe('parseClaudeSession — model and timestamps', () => {
  it('picks up the model name', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ model: 'claude-3-7-sonnet-20250219', inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(parseClaudeSession(file).model).toBe('claude-3-7-sonnet-20250219');
  });

  it('tracks startedAt / endedAt from timestamps', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ timestamp: '2024-06-01T10:05:00.000Z', inputTokens: 50, outputTokens: 20 }),
      makeAssistant({ timestamp: '2024-06-01T10:00:00.000Z', inputTokens: 50, outputTokens: 20 }),
    ]);
    const result = parseClaudeSession(file);
    expect(result.startedAt).toBe('2024-06-01T10:00:00.000Z');
    expect(result.endedAt).toBe('2024-06-01T10:05:00.000Z');
  });
});

describe('parseClaudeSession — subagent files', () => {
  it('aggregates tokens from subagent JSONL files', () => {
    const mainFile = writeTmpJsonl('abc123.jsonl', [
      makeAssistant({ inputTokens: 100, outputTokens: 40 }),
    ]);

    const sessionDir = join(tmpDir, 'abc123');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, 'sub1.jsonl'),
      JSON.stringify(makeAssistant({ inputTokens: 200, outputTokens: 80 })) + '\n'
    );

    const result = parseClaudeSession(mainFile);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(120);
    expect(result.totalTokens).toBe(420);
  });
});

describe('parseClaudeSession — per-day buckets', () => {
  it('files each turn under the day it actually ran on', () => {
    // The bug: this session was created on 06-01, so every one of its tokens —
    // including 06-02's — used to be reported with a 06-01 `started_at`.
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ timestamp: '2024-06-01T22:00:00.000Z', inputTokens: 100, outputTokens: 10 }),
      makeAssistant({ timestamp: '2024-06-02T09:00:00.000Z', inputTokens: 200, outputTokens: 20 }),
      makeAssistant({ timestamp: '2024-06-02T15:00:00.000Z', inputTokens: 300, outputTokens: 30 }),
    ]);

    const result = parseClaudeSession(file);

    expect(result.byDate.map((b) => b.date)).toEqual(['2024-06-01', '2024-06-02']);
    expect(result.byDate[0].totalTokens).toBe(110);
    expect(result.byDate[1].totalTokens).toBe(550);
    expect(result.byDate[1].startedAt).toBe('2024-06-02T09:00:00.000Z');
    expect(result.byDate[1].endedAt).toBe('2024-06-02T15:00:00.000Z');
  });

  it('keeps the day buckets summing to the session totals', () => {
    const file = writeTmpJsonl('session.jsonl', [
      makeAssistant({ timestamp: '2024-06-01T10:00:00.000Z', inputTokens: 100, outputTokens: 10, cacheCreation: 5, cacheRead: 7 }),
      makeAssistant({ timestamp: '2024-06-02T10:00:00.000Z', inputTokens: 200, outputTokens: 20, cacheCreation: 6, cacheRead: 8 }),
      makeAssistant({ timestamp: '2024-06-03T10:00:00.000Z', inputTokens: 300, outputTokens: 30, cacheCreation: 7, cacheRead: 9 }),
    ]);

    const result = parseClaudeSession(file);
    const sum = (field) => result.byDate.reduce((n, b) => n + b[field], 0);

    expect(sum('inputTokens')).toBe(result.inputTokens);
    expect(sum('outputTokens')).toBe(result.outputTokens);
    expect(sum('cacheCreationTokens')).toBe(result.cacheCreationTokens);
    expect(sum('cacheReadTokens')).toBe(result.cacheReadTokens);
    expect(sum('totalTokens')).toBe(result.totalTokens);
  });

  it('merges subagent tokens into the day the subagent ran on', () => {
    const mainFile = writeTmpJsonl('abc123.jsonl', [
      makeAssistant({ timestamp: '2024-06-01T10:00:00.000Z', inputTokens: 100, outputTokens: 40 }),
    ]);

    const subagentsDir = join(tmpDir, 'abc123', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, 'sub1.jsonl'),
      JSON.stringify(
        makeAssistant({ timestamp: '2024-06-02T10:00:00.000Z', inputTokens: 200, outputTokens: 80 })
      ) + '\n'
    );

    const result = parseClaudeSession(mainFile);

    expect(result.byDate.map((b) => b.date)).toEqual(['2024-06-01', '2024-06-02']);
    expect(result.byDate[0].totalTokens).toBe(140);
    expect(result.byDate[1].totalTokens).toBe(280);
  });
});
