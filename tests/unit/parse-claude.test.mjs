/**
 * Tests for plugin/hooks/claude/parse-claude.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseClaudeSession,
  convertLineCountedWatermark,
} from '../../plugin/hooks/claude/parse-claude.mjs';

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

describe('parseClaudeSession — cache-write TTL split', () => {
  // Anthropic prices a 5-minute cache write at 1.25x the input rate and a
  // 1-hour write at 2x. Without the split the server cannot cost a
  // cache-heavy session at all, which is why cache_creation used to
  // contribute exactly $0 to every estimate.
  function withCacheCreation(fiveMin, oneHour, total) {
    const entry = makeAssistant({ cacheCreation: total });
    entry.message.usage.cache_creation = {
      ephemeral_5m_input_tokens: fiveMin,
      ephemeral_1h_input_tokens: oneHour,
    };
    return entry;
  }

  it('splits cache creation into its two TTL buckets', () => {
    const file = writeTmpJsonl('sess.jsonl', [withCacheCreation(0, 9140, 9140)]);
    const result = parseClaudeSession(file);

    expect(result.cacheCreationTokens).toBe(9140);
    expect(result.cacheCreation5mTokens).toBe(0);
    expect(result.cacheCreation1hTokens).toBe(9140);
  });

  it('keeps the split out of totalTokens — it is a breakdown, not extra usage', () => {
    const file = writeTmpJsonl('sess.jsonl', [withCacheCreation(400, 600, 1000)]);
    const result = parseClaudeSession(file);

    expect(result.cacheCreation5mTokens + result.cacheCreation1hTokens).toBe(
      result.cacheCreationTokens
    );
    expect(result.totalTokens).toBe(
      result.inputTokens + result.outputTokens + result.cacheCreationTokens + result.cacheReadTokens
    );
  });

  it('reports zeros when the transcript predates the split field', () => {
    const file = writeTmpJsonl('sess.jsonl', [makeAssistant({ cacheCreation: 500 })]);
    const result = parseClaudeSession(file);

    expect(result.cacheCreationTokens).toBe(500);
    expect(result.cacheCreation5mTokens).toBe(0);
    expect(result.cacheCreation1hTokens).toBe(0);
  });

  it('sums the split across turns and days', () => {
    const a = withCacheCreation(100, 200, 300);
    a.timestamp = '2024-06-01T10:00:00.000Z';
    const b = withCacheCreation(50, 250, 300);
    b.timestamp = '2024-06-02T10:00:00.000Z';

    const result = parseClaudeSession(writeTmpJsonl('sess.jsonl', [a, b]));

    expect(result.cacheCreation5mTokens).toBe(150);
    expect(result.cacheCreation1hTokens).toBe(450);
    expect(result.byDate).toHaveLength(2);
    expect(result.byDate[0].cacheCreation1hTokens).toBe(200);
    expect(result.byDate[1].cacheCreation1hTokens).toBe(250);
  });
});

describe('parseClaudeSession — cwd (routing anchor)', () => {
  // The live hook takes cwd from its payload, but a session found by the
  // cross-agent sweep has no payload — so the transcript has to supply it, or
  // the session cannot be routed to the right server. Read only; never uploaded.
  it('returns the cwd recorded on a transcript entry', () => {
    const file = writeTmpJsonl('sess.jsonl', [
      { ...makeAssistant(), cwd: 'C:\\work\\proj' },
    ]);
    expect(parseClaudeSession(file).cwd).toBe('C:\\work\\proj');
  });

  it('is undefined when the transcript records none', () => {
    const file = writeTmpJsonl('sess.jsonl', [makeAssistant()]);
    expect(parseClaudeSession(file).cwd).toBeUndefined();
  });

  it('prefers the parent transcript cwd over a subagent that ran elsewhere', () => {
    const mainFile = writeTmpJsonl('abc123.jsonl', [
      { ...makeAssistant({ inputTokens: 10 }), cwd: '/work/parent' },
    ]);
    const subagentsDir = join(tmpDir, 'abc123', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, 'sub1.jsonl'),
      JSON.stringify({ ...makeAssistant({ inputTokens: 20 }), cwd: '/work/elsewhere' }) + '\n'
    );

    expect(parseClaudeSession(mainFile).cwd).toBe('/work/parent');
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

describe('parseClaudeSession — one API response written as several lines', () => {
  // Claude Code does not write one line per API response. It writes one line
  // per content block (thinking, text, tool_use), and every one of those lines
  // carries the same message id, request id, stop_reason and the response's
  // FULL usage. Summing lines therefore bills a three-block response three
  // times. Measured against real transcripts this overstated usage by ~1.8x.
  function makeResponseLines(opts = {}) {
    const blocks = opts.blocks ?? ['thinking', 'text', 'tool_use'];
    return blocks.map((blockType, i) => {
      const entry = makeAssistant({
        ...opts,
        timestamp: opts.timestamp ?? `2024-06-01T10:00:00.00${i}Z`,
      });
      entry.requestId = opts.requestId ?? 'req_1';
      entry.message.id = opts.messageId ?? 'msg_1';
      entry.message.content = [{ type: blockType }];
      return entry;
    });
  }

  it('counts a response once, however many content blocks it was split into', () => {
    const file = writeTmpJsonl('session.jsonl', makeResponseLines({
      inputTokens: 10,
      outputTokens: 200,
      cacheCreation: 3000,
      cacheRead: 40000,
    }));

    const result = parseClaudeSession(file);

    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(200);
    expect(result.cacheCreationTokens).toBe(3000);
    expect(result.cacheReadTokens).toBe(40000);
    expect(result.totalTokens).toBe(43210);
  });

  it('does not let the block count change the session total', () => {
    const file = writeTmpJsonl('session.jsonl', [
      ...makeResponseLines({ messageId: 'msg_a', requestId: 'req_a', blocks: ['text'], outputTokens: 10 }),
      ...makeResponseLines({ messageId: 'msg_b', requestId: 'req_b', blocks: ['thinking', 'tool_use'], outputTokens: 20 }),
      ...makeResponseLines({ messageId: 'msg_c', requestId: 'req_c', blocks: ['thinking', 'text', 'tool_use'], outputTokens: 30 }),
    ]);

    const result = parseClaudeSession(file);

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(60);
    expect(result.totalTokens).toBe(360);
  });

  it('still counts distinct responses that happen to report identical usage', () => {
    const file = writeTmpJsonl('session.jsonl', [
      ...makeResponseLines({ messageId: 'msg_a', requestId: 'req_a', blocks: ['text'] }),
      ...makeResponseLines({ messageId: 'msg_b', requestId: 'req_b', blocks: ['text'] }),
    ]);

    const result = parseClaudeSession(file);

    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);
  });

  it('counts the cache-write TTL split once per response too', () => {
    const lines = makeResponseLines({ cacheCreation: 1000 });
    for (const line of lines) {
      line.message.usage.cache_creation = {
        ephemeral_5m_input_tokens: 400,
        ephemeral_1h_input_tokens: 600,
      };
    }
    const file = writeTmpJsonl('session.jsonl', lines);

    const result = parseClaudeSession(file);

    expect(result.cacheCreationTokens).toBe(1000);
    expect(result.cacheCreation5mTokens).toBe(400);
    expect(result.cacheCreation1hTokens).toBe(600);
  });

  it('keeps the day buckets equal to the deduplicated totals', () => {
    const file = writeTmpJsonl('session.jsonl', [
      ...makeResponseLines({ messageId: 'msg_a', requestId: 'req_a', timestamp: '2024-06-01T23:59:59.000Z' }),
      ...makeResponseLines({ messageId: 'msg_b', requestId: 'req_b', timestamp: '2024-06-02T00:00:01.000Z' }),
    ]);

    const result = parseClaudeSession(file);

    expect(result.byDate.map((b) => [b.date, b.totalTokens])).toEqual([
      ['2024-06-01', 150],
      ['2024-06-02', 150],
    ]);
    expect(result.totalTokens).toBe(300);
  });
});

describe('convertLineCountedWatermark — ledger records from line-counting collectors', () => {
  // What a collector that summed lines recorded as sent. Each line repeats its
  // response's full usage, so a response of n lines was counted n times.
  function lineCounted(entries) {
    const sum = (field) => entries.reduce((n, e) => n + e.message.usage[field], 0);
    const inputTokens = sum('input_tokens');
    const outputTokens = sum('output_tokens');
    return { inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: inputTokens + outputTokens };
  }

  function response(id, timestamp, blocks, inputTokens, outputTokens) {
    return Array.from({ length: blocks }, () => {
      const entry = makeAssistant({ timestamp, inputTokens, outputTokens });
      entry.requestId = `req_${id}`;
      entry.message.id = `msg_${id}`;
      return entry;
    });
  }

  const a = response('a', '2024-06-01T10:00:00.000Z', 3, 100, 10);
  const b = response('b', '2024-06-01T10:05:00.000Z', 2, 200, 20);
  const c = response('c', '2024-06-01T10:10:00.000Z', 1, 300, 30);

  it('finds the responses a mid-session upload had covered, counting each once', () => {
    const file = writeTmpJsonl('session.jsonl', [...a, ...b, ...c]);

    const converted = convertLineCountedWatermark(file, lineCounted([...a, ...b]));

    expect(converted.inputTokens).toBe(300);
    expect(converted.outputTokens).toBe(30);
    expect(converted.totalTokens).toBe(330);
    // So the next delta is exactly the response the old upload never saw.
    expect(parseClaudeSession(file).totalTokens - converted.totalTokens).toBe(330);
  });

  it('converts a watermark of the whole session to the session total', () => {
    const file = writeTmpJsonl('session.jsonl', [...a, ...b, ...c]);

    const converted = convertLineCountedWatermark(file, lineCounted([...a, ...b, ...c]));
    const parsed = parseClaudeSession(file);

    expect(converted.inputTokens).toBe(parsed.inputTokens);
    expect(converted.outputTokens).toBe(parsed.outputTokens);
    expect(converted.totalTokens).toBe(parsed.totalTokens);
  });

  it('replays the parent and its subagents in time order', () => {
    const mainFile = writeTmpJsonl('abc123.jsonl', [...a, ...c]);
    const subagentsDir = join(tmpDir, 'abc123', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'sub1.jsonl'), b.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // The old upload ran after the subagent's response but before c.
    const converted = convertLineCountedWatermark(mainFile, lineCounted([...a, ...b]));

    expect(converted.totalTokens).toBe(330);
  });

  it('converts an empty watermark to zero', () => {
    const file = writeTmpJsonl('session.jsonl', [...a]);
    expect(convertLineCountedWatermark(file, { totalTokens: 0 }).totalTokens).toBe(0);
  });

  it('returns null when the transcript cannot be read', () => {
    expect(convertLineCountedWatermark(join(tmpDir, 'gone.jsonl'), { totalTokens: 500 })).toBeNull();
  });
});
