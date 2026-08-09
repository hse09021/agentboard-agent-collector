/**
 * Tests for plugin/hooks/lib/daily-split.mjs
 *
 * The bug this guards: uploads are delta-based but carried the session's FIRST
 * timestamp as `started_at`, so a session created yesterday and resumed today
 * had today's tokens filed under yesterday.
 */

import { describe, it, expect } from 'vitest';
import {
  addToDayBucket,
  sortDayBuckets,
  mergeDayBuckets,
  splitDeltaByDate,
  splitSessionDelta,
  sumPieceTokens,
  TOKEN_FIELDS,
} from '../../plugin/hooks/lib/daily-split.mjs';

function turn(input, output, cacheCreation = 0, cacheRead = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheCreation + cacheRead,
  };
}

function buildBuckets(entries) {
  const buckets = new Map();
  for (const [ts, tokens] of entries) addToDayBucket(buckets, ts, tokens);
  return sortDayBuckets(buckets);
}

function sumField(items, field) {
  return items.reduce((n, item) => n + (item[field] ?? 0), 0);
}

describe('addToDayBucket', () => {
  it('groups turns by UTC calendar day', () => {
    const buckets = buildBuckets([
      ['2024-06-01T23:50:00.000Z', turn(100, 10)],
      ['2024-06-02T00:10:00.000Z', turn(200, 20)],
      ['2024-06-02T09:00:00.000Z', turn(300, 30)],
    ]);

    expect(buckets.map((b) => b.date)).toEqual(['2024-06-01', '2024-06-02']);
    expect(buckets[0].totalTokens).toBe(110);
    expect(buckets[1].totalTokens).toBe(550);
  });

  it('tracks the first and last timestamp within each day', () => {
    const buckets = buildBuckets([
      ['2024-06-02T09:00:00.000Z', turn(10, 1)],
      ['2024-06-02T00:10:00.000Z', turn(10, 1)],
      ['2024-06-02T18:30:00.000Z', turn(10, 1)],
    ]);

    expect(buckets[0].startedAt).toBe('2024-06-02T00:10:00.000Z');
    expect(buckets[0].endedAt).toBe('2024-06-02T18:30:00.000Z');
  });

  it('keeps every token field separate', () => {
    const buckets = buildBuckets([['2024-06-01T10:00:00.000Z', turn(100, 20, 30, 40)]]);

    expect(buckets[0].inputTokens).toBe(100);
    expect(buckets[0].outputTokens).toBe(20);
    expect(buckets[0].cacheCreationTokens).toBe(30);
    expect(buckets[0].cacheReadTokens).toBe(40);
    expect(buckets[0].totalTokens).toBe(190);
  });

  it('returns days in ascending order regardless of insertion order', () => {
    const buckets = buildBuckets([
      ['2024-06-03T10:00:00.000Z', turn(10, 1)],
      ['2024-06-01T10:00:00.000Z', turn(10, 1)],
      ['2024-06-02T10:00:00.000Z', turn(10, 1)],
    ]);

    expect(buckets.map((b) => b.date)).toEqual(['2024-06-01', '2024-06-02', '2024-06-03']);
  });
});

describe('mergeDayBuckets', () => {
  it('folds a subagent list into the parent on matching days', () => {
    const parent = buildBuckets([['2024-06-01T10:00:00.000Z', turn(100, 10)]]);
    const child = buildBuckets([
      ['2024-06-01T14:00:00.000Z', turn(50, 5)],
      ['2024-06-02T09:00:00.000Z', turn(70, 7)],
    ]);

    const merged = mergeDayBuckets(parent, child);

    expect(merged.map((b) => b.date)).toEqual(['2024-06-01', '2024-06-02']);
    expect(merged[0].totalTokens).toBe(165);
    expect(merged[0].endedAt).toBe('2024-06-01T14:00:00.000Z');
    expect(merged[1].totalTokens).toBe(77);
  });

  it('does not mutate its inputs', () => {
    const parent = buildBuckets([['2024-06-01T10:00:00.000Z', turn(100, 10)]]);
    const child = buildBuckets([['2024-06-01T14:00:00.000Z', turn(50, 5)]]);

    mergeDayBuckets(parent, child);

    expect(parent[0].totalTokens).toBe(110);
    expect(child[0].totalTokens).toBe(55);
  });

  it('tolerates empty and missing lists', () => {
    expect(mergeDayBuckets([], undefined)).toEqual([]);
  });
});

describe('splitDeltaByDate', () => {
  it('THE BUG: a session created yesterday reports today under today', () => {
    // 100k already uploaded yesterday; the session is resumed today for 50k more.
    const buckets = buildBuckets([
      ['2024-06-01T22:00:00.000Z', turn(90_000, 10_000)],
      ['2024-06-02T09:00:00.000Z', turn(45_000, 5_000)],
    ]);
    const alreadySent = turn(90_000, 10_000);

    const pieces = splitDeltaByDate(buckets, alreadySent);

    expect(pieces).toHaveLength(1);
    expect(pieces[0].date).toBe('2024-06-02');
    expect(pieces[0].totalTokens).toBe(50_000);
    // The timestamp the event is stamped with must fall inside the day it is
    // attributed to — that is the whole point of the split.
    expect(pieces[0].startedAt.slice(0, 10)).toBe('2024-06-02');
  });

  it('splits a delta that spans midnight into one piece per day', () => {
    const buckets = buildBuckets([
      ['2024-06-01T23:50:00.000Z', turn(1_000, 100)],
      ['2024-06-02T00:10:00.000Z', turn(2_000, 200)],
    ]);

    const pieces = splitDeltaByDate(buckets, turn(0, 0));

    expect(pieces.map((p) => p.date)).toEqual(['2024-06-01', '2024-06-02']);
    expect(pieces[0].totalTokens).toBe(1_100);
    expect(pieces[1].totalTokens).toBe(2_200);
  });

  it('charges already-sent totals against the earliest days first', () => {
    // Only part of day 1 had been uploaded — the rest of day 1 must still land
    // on day 1, not be pushed onto day 2.
    const buckets = buildBuckets([
      ['2024-06-01T10:00:00.000Z', turn(1_000, 100)],
      ['2024-06-02T10:00:00.000Z', turn(2_000, 200)],
    ]);
    const alreadySent = turn(600, 60);

    const pieces = splitDeltaByDate(buckets, alreadySent);

    expect(pieces).toHaveLength(2);
    expect(pieces[0].date).toBe('2024-06-01');
    expect(pieces[0].inputTokens).toBe(400);
    expect(pieces[0].outputTokens).toBe(40);
    expect(pieces[1].date).toBe('2024-06-02');
    expect(pieces[1].totalTokens).toBe(2_200);
  });

  it('returns nothing when the ledger already covers the session', () => {
    const buckets = buildBuckets([
      ['2024-06-01T10:00:00.000Z', turn(1_000, 100)],
      ['2024-06-02T10:00:00.000Z', turn(2_000, 200)],
    ]);

    expect(splitDeltaByDate(buckets, turn(3_000, 300))).toEqual([]);
  });

  it('never returns a negative delta when the ledger runs ahead', () => {
    const buckets = buildBuckets([['2024-06-01T10:00:00.000Z', turn(1_000, 100)]]);

    expect(splitDeltaByDate(buckets, turn(9_999, 999))).toEqual([]);
  });

  it('covers a multi-day gap when uploads were offline', () => {
    const buckets = buildBuckets([
      ['2024-06-01T10:00:00.000Z', turn(100, 10)],
      ['2024-06-02T10:00:00.000Z', turn(200, 20)],
      ['2024-06-03T10:00:00.000Z', turn(300, 30)],
    ]);

    const pieces = splitDeltaByDate(buckets, turn(0, 0));

    expect(pieces.map((p) => p.date)).toEqual(['2024-06-01', '2024-06-02', '2024-06-03']);
    expect(sumPieceTokens(pieces)).toBe(660);
  });

  it('conserves every token field: sent + split === cumulative', () => {
    const buckets = buildBuckets([
      ['2024-06-01T10:00:00.000Z', turn(1_000, 100, 50, 25)],
      ['2024-06-02T10:00:00.000Z', turn(2_000, 200, 60, 35)],
      ['2024-06-03T10:00:00.000Z', turn(3_000, 300, 70, 45)],
    ]);
    const alreadySent = turn(1_500, 150, 80, 40);

    const pieces = splitDeltaByDate(buckets, alreadySent);

    for (const field of TOKEN_FIELDS) {
      expect(sumField(pieces, field) + alreadySent[field]).toBe(sumField(buckets, field));
    }
  });

  it('skips days whose delta is fully consumed', () => {
    const buckets = buildBuckets([
      ['2024-06-01T10:00:00.000Z', turn(100, 10)],
      ['2024-06-02T10:00:00.000Z', turn(100, 10)],
      ['2024-06-03T10:00:00.000Z', turn(100, 10)],
    ]);

    const pieces = splitDeltaByDate(buckets, turn(200, 20));

    expect(pieces.map((p) => p.date)).toEqual(['2024-06-03']);
  });

  it('returns nothing for an empty or missing bucket list', () => {
    expect(splitDeltaByDate([], turn(0, 0))).toEqual([]);
    expect(splitDeltaByDate(undefined, turn(0, 0))).toEqual([]);
  });
});

describe('splitSessionDelta', () => {
  it('uses the day buckets when the parse provides them', () => {
    const parsed = {
      startedAt: '2024-06-01T22:00:00.000Z',
      endedAt: '2024-06-02T09:00:00.000Z',
      ...turn(3_000, 300),
      byDate: buildBuckets([
        ['2024-06-01T22:00:00.000Z', turn(1_000, 100)],
        ['2024-06-02T09:00:00.000Z', turn(2_000, 200)],
      ]),
    };

    const pieces = splitSessionDelta(parsed, turn(1_000, 100));

    expect(pieces).toHaveLength(1);
    expect(pieces[0].date).toBe('2024-06-02');
  });

  it('falls back to a single flat delta when no day breakdown exists', () => {
    // Losing tokens is worse than attributing them imprecisely, so a parse with
    // no byDate must still upload — on the session's own timestamps.
    const parsed = {
      startedAt: '2024-06-01T22:00:00.000Z',
      endedAt: '2024-06-02T09:00:00.000Z',
      ...turn(3_000, 300),
    };

    const pieces = splitSessionDelta(parsed, turn(1_000, 100));

    expect(pieces).toHaveLength(1);
    expect(pieces[0].startedAt).toBe('2024-06-01T22:00:00.000Z');
    expect(pieces[0].totalTokens).toBe(2_200);
  });

  it('returns nothing when the fallback delta is empty', () => {
    const parsed = { startedAt: '2024-06-01T22:00:00.000Z', ...turn(1_000, 100) };

    expect(splitSessionDelta(parsed, turn(1_000, 100))).toEqual([]);
  });
});
