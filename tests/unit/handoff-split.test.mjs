/**
 * Splitting a session's outstanding delta at the moment its directory was
 * connected (#17).
 *
 * A session that started on the community server and kept going after its
 * directory was connected has one cumulative ledger total. What it owes each
 * server is reconstructed from per-response timestamps: tokens before
 * `connected_at` belong to the community server, tokens after to the
 * organization's, and whatever was already uploaded counts as the earliest.
 */

import { describe, it, expect } from 'vitest';
import { splitBucketedDelta, TOKEN_FIELDS } from '../../plugin/hooks/lib/daily-split.mjs';
import { bucketKeyString } from '../../plugin/hooks/lib/usage-buckets.mjs';

function turn(input, output, cacheCreation = 0, cacheRead = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: cacheRead,
    cacheWriteInputTokens: 0,
    totalTokens: input + output + cacheCreation + cacheRead,
  };
}

// One bucket key throughout: per-key behaviour is covered in usage-buckets.
const KEY = { model: 'claude-opus-5-5', speed: 'standard', contextSizeBucket: 'up_to_100k' };
const KS = bucketKeyString(KEY);

function session(entries) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0]));
  for (const { turn: t } of entries) for (const f of TOKEN_FIELDS) totals[f] += t[f];
  return { ...totals, model: KEY.model, entries: entries.map((e) => ({ ...e, key: KEY })) };
}

// The single-key view of splitBucketedDelta.
function splitHandoffDelta(parsed, alreadySent, splitAt) {
  const { earlier, later } = splitBucketedDelta(parsed, { [KS]: alreadySent }, { splitAt });
  return {
    earlier: { pieces: earlier.pieces, watermark: earlier.watermarks[KS], sentAfter: earlier.record[KS] },
    later: { pieces: later.pieces, watermark: later.watermarks[KS] },
  };
}

const zero = turn(0, 0);
const sum = (pieces, field = 'totalTokens') => pieces.reduce((n, p) => n + p[field], 0);

describe('splitBucketedDelta at a connection', () => {
  const CONNECTED = '2026-11-20T12:00:00.000Z';

  const parsed = session([
    { ts: '2026-11-20T10:00:00.000Z', turn: turn(1_000, 100) }, // uploaded before connect
    { ts: '2026-11-20T11:00:00.000Z', turn: turn(2_000, 200) }, // pre-connect, not yet uploaded
    { ts: '2026-11-20T13:00:00.000Z', turn: turn(4_000, 400) }, // post-connect
    { ts: '2026-11-21T09:00:00.000Z', turn: turn(8_000, 800) }, // post-connect, next day
  ]);

  it('sends the unsent pre-connect tail to the community and only post-connect tokens onward', () => {
    const { earlier, later } = splitHandoffDelta(parsed, turn(1_000, 100), CONNECTED);

    expect(sum(earlier.pieces)).toBe(2_200);
    expect(sum(later.pieces)).toBe(4_400 + 8_800);
    // Nothing from before the connection reaches the organization.
    expect(later.pieces.every((p) => p.startedAt >= CONNECTED)).toBe(true);
    expect(earlier.pieces.every((p) => p.endedAt < CONNECTED)).toBe(true);
  });

  it('accounts for the whole outstanding delta, field by field', () => {
    const alreadySent = turn(1_000, 100);
    const { earlier, later } = splitHandoffDelta(parsed, alreadySent, CONNECTED);
    for (const field of TOKEN_FIELDS) {
      expect(sum(earlier.pieces, field) + sum(later.pieces, field), field).toBe(
        parsed[field] - alreadySent[field]
      );
    }
  });

  it('cuts the day the connection happened into one piece per side', () => {
    const { earlier, later } = splitHandoffDelta(parsed, zero, CONNECTED);
    expect(earlier.pieces.map((p) => p.date)).toEqual(['2026-11-20']);
    expect(later.pieces.map((p) => p.date)).toEqual(['2026-11-20', '2026-11-21']);
    expect(later.pieces[0].startedAt).toBe('2026-11-20T13:00:00.000Z');
  });

  it('handles a connection on a different day from the pre-connect work', () => {
    const { earlier, later } = splitHandoffDelta(parsed, zero, '2026-11-21T00:00:00.000Z');
    expect(earlier.pieces.map((p) => [p.date, p.totalTokens])).toEqual([['2026-11-20', 7_700]]);
    expect(later.pieces.map((p) => [p.date, p.totalTokens])).toEqual([['2026-11-21', 8_800]]);
  });

  it('records the community side as max(alreadySent, before) and keys its ids on alreadySent', () => {
    const alreadySent = turn(1_000, 100);
    const { earlier, later } = splitHandoffDelta(parsed, alreadySent, CONNECTED);
    expect(earlier.watermark.totalTokens).toBe(1_100);
    expect(earlier.sentAfter.totalTokens).toBe(3_300);
    expect(later.watermark).toEqual(earlier.sentAfter);
  });

  // A collector without this fix kept uploading post-connect tokens to the
  // community server. They cannot be recalled, but must not be sent twice.
  it('subtracts post-connect tokens an older collector already sent to the community', () => {
    const alreadySent = turn(1_000 + 2_000 + 4_000, 100 + 200 + 400);
    const { earlier, later } = splitHandoffDelta(parsed, alreadySent, CONNECTED);
    expect(earlier.pieces).toEqual([]);
    expect(sum(later.pieces)).toBe(8_800);
    expect(later.pieces.map((p) => p.date)).toEqual(['2026-11-21']);
  });

  it('has nothing for the community once the tail is sent, and the same organization side', () => {
    const first = splitHandoffDelta(parsed, turn(1_000, 100), CONNECTED);
    const retry = splitHandoffDelta(parsed, first.earlier.sentAfter, CONNECTED);
    expect(retry.earlier.pieces).toEqual([]);
    expect(retry.later).toEqual(first.later);
  });

  it('sends nothing onward when no work happened after the connection', () => {
    const { earlier, later } = splitHandoffDelta(parsed, zero, '2026-11-22T00:00:00.000Z');
    expect(sum(earlier.pieces)).toBe(parsed.totalTokens);
    expect(later.pieces).toEqual([]);
  });

  it('treats a session without per-response entries as entirely post-connect', () => {
    const { entries, ...flat } = parsed;
    const { earlier, later } = splitBucketedDelta(
      { ...flat, startedAt: '2026-11-20T10:00:00.000Z' },
      { [KS]: turn(1_000, 100) },
      { splitAt: CONNECTED }
    );
    expect(earlier.pieces).toEqual([]);
    expect(sum(later.pieces)).toBe(parsed.totalTokens - 1_100);
    expect(later.pieces[0].key.model).toBe(KEY.model);
  });
});

// #23: in "listed" scope a tracked directory sends only what was used after
// it was added. Earlier tokens are withheld: never sent, but covered once a
// later upload lands.
describe('splitBucketedDelta with since', () => {
  const parsed = session([
    { ts: '2026-11-20T10:00:00.000Z', turn: turn(1_000, 100) },
    { ts: '2026-11-20T11:00:00.000Z', turn: turn(2_000, 200) },
    { ts: '2026-11-20T13:00:00.000Z', turn: turn(4_000, 400) },
  ]);
  const zero = turn(0, 0);
  const total = (pieces) => pieces.reduce((n, p) => n + p.totalTokens, 0);

  it('sends only what came after since, and records everything as covered', () => {
    const { earlier, later } = splitBucketedDelta(parsed, {}, { since: '2026-11-20T10:30:00.000Z' });
    expect(earlier).toBeNull();
    expect(total(later.pieces)).toBe(2_200 + 4_400);
    expect(later.pieces.every((p) => p.startedAt >= '2026-11-20T10:30:00.000Z')).toBe(true);
    expect(later.record[KS].totalTokens).toBe(parsed.totalTokens);
    expect(later.watermarks[KS].totalTokens).toBe(1_100);
  });

  it('does not withhold twice what the ledger already covers', () => {
    const { later } = splitBucketedDelta(parsed, { [KS]: turn(3_000, 300) }, { since: '2026-11-20T10:30:00.000Z' });
    expect(total(later.pieces)).toBe(4_400);
  });

  it('withholds only the community side of a hand-off', () => {
    const { earlier, later } = splitBucketedDelta(parsed, { [KS]: zero }, {
      since: '2026-11-20T10:30:00.000Z',
      splitAt: '2026-11-20T12:00:00.000Z',
    });
    expect(total(earlier.pieces)).toBe(2_200);
    expect(total(later.pieces)).toBe(4_400);
    expect(earlier.record[KS].totalTokens).toBe(1_100 + 2_200);
  });

  // A directory tracked after it was connected: the organization still gets
  // everything after the connection.
  it('never withholds past the connection', () => {
    const { earlier, later } = splitBucketedDelta(parsed, { [KS]: zero }, {
      since: '2026-11-21T00:00:00.000Z',
      splitAt: '2026-11-20T12:00:00.000Z',
    });
    expect(earlier.pieces).toEqual([]);
    expect(total(later.pieces)).toBe(4_400);
  });
});
