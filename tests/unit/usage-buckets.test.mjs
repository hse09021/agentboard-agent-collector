/**
 * Usage per bucket key (#19).
 *
 * A session used to be uploaded as a single model, so the server priced all of
 * it at that one model's rate: a Haiku subagent inside an Opus session at Opus
 * rates, fast mode at standard rates, a request past a long-prompt tier at the
 * short one. Each response now carries a bucket key (model, speed, prompt-size
 * tier, inference geo), and the delta is summed and uploaded per key.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTEXT_SIZE_BUCKETS,
  bucketEventFields,
  bucketKeyString,
  contextSizeBucket,
  makeBucketKey,
} from '../../plugin/hooks/lib/usage-buckets.mjs';
import {
  TOKEN_FIELDS,
  allocateWatermarkByTime,
  splitBucketedDelta,
  sumByKey,
} from '../../plugin/hooks/lib/daily-split.mjs';
import { assertNoForbiddenFields } from '../../plugin/hooks/lib/forbidden-data-guard.mjs';
import { deriveEventId } from '../../plugin/hooks/lib/config.mjs';

function turn(input, output = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: input + output,
  };
}

const OPUS = makeBucketKey({ model: 'claude-opus-5-5', speed: 'standard', contextSizeBucket: 'up_to_272k' });
const OPUS_FAST = makeBucketKey({ model: 'claude-opus-5-5', speed: 'fast', contextSizeBucket: 'up_to_272k' });
const HAIKU = makeBucketKey({ model: 'claude-haiku-5-5', speed: 'standard', contextSizeBucket: 'up_to_100k' });

function session(entries) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0]));
  for (const { turn: t } of entries) for (const f of TOKEN_FIELDS) totals[f] += t[f];
  return { ...totals, model: 'claude-opus-5-5', entries };
}

const parsed = session([
  { ts: '2026-11-20T10:00:00.000Z', turn: turn(1_000, 10), key: OPUS },
  { ts: '2026-11-20T10:05:00.000Z', turn: turn(200, 2), key: HAIKU },
  { ts: '2026-11-20T11:00:00.000Z', turn: turn(3_000, 30), key: OPUS_FAST },
  { ts: '2026-11-21T09:00:00.000Z', turn: turn(4_000, 40), key: OPUS },
  { ts: '2026-11-21T09:05:00.000Z', turn: turn(500, 5), key: HAIKU },
]);

const byPiece = (pieces) => pieces.map((p) => [p.date, p.key.model, p.key.speed, p.totalTokens]);

describe('contextSizeBucket', () => {
  it('puts a prompt on the tier boundary in the lower tier', () => {
    expect(contextSizeBucket(0)).toBe('up_to_100k');
    expect(contextSizeBucket(100_000)).toBe('up_to_100k');
    expect(contextSizeBucket(100_001)).toBe('up_to_272k');
    expect(contextSizeBucket(272_000)).toBe('up_to_272k');
    expect(contextSizeBucket(272_001)).toBe('over_272k');
  });

  it('sends only boundaries, never a price', () => {
    expect(CONTEXT_SIZE_BUCKETS.map((b) => b.label)).toEqual(['up_to_100k', 'up_to_272k', 'over_272k']);
  });
});

describe('makeBucketKey', () => {
  it('defaults the speed to standard', () => {
    expect(makeBucketKey({ model: 'm' }).speed).toBe('standard');
    expect(makeBucketKey({ model: 'm', speed: null }).speed).toBe('standard');
  });

  // These come from the AI tool's transcript and go to the server verbatim.
  it('drops anything that is not a short identifier', () => {
    const key = makeBucketKey({ model: 'm', speed: 'fast; drop table', inferenceGeo: { us: true } });
    expect(key).toEqual({ model: 'm', speed: 'standard', contextSizeBucket: null, inferenceGeo: null });
    expect(makeBucketKey({ model: 'm', inferenceGeo: 'us' }).inferenceGeo).toBe('us');
  });

  it('gives equal keys equal strings and different keys different ones', () => {
    expect(bucketKeyString({ ...OPUS })).toBe(bucketKeyString(OPUS));
    expect(new Set([OPUS, OPUS_FAST, HAIKU].map(bucketKeyString)).size).toBe(3);
  });
});

describe('bucketEventFields', () => {
  it('carries model, speed, tier and geo, leaving unknown parts out', () => {
    expect(bucketEventFields({ ...OPUS_FAST, inferenceGeo: 'us' })).toEqual({
      model: 'claude-opus-5-5',
      speed: 'fast',
      context_size_bucket: 'up_to_272k',
      inference_geo: 'us',
    });
    expect(bucketEventFields(null, 'codex')).toEqual({ model: 'codex', speed: 'standard' });
  });

  // The issue proposed `prompt_size_bucket`; the guard rejects any key
  // containing "prompt" (or "pr"), on the collector and on both servers.
  it('uses field names the privacy guard lets through', () => {
    const fields = bucketEventFields({ ...OPUS, inferenceGeo: 'global' });
    expect(() => assertNoForbiddenFields({ ...fields, cache_write_input_tokens: 0 })).not.toThrow();
    expect(() => assertNoForbiddenFields({ prompt_size_bucket: 'up_to_100k' })).toThrow();
  });
});

describe('splitBucketedDelta', () => {
  it('uploads each key and day as its own piece', () => {
    const { earlier, later } = splitBucketedDelta(parsed, {});
    expect(earlier).toBeNull();
    expect(byPiece(later.pieces)).toEqual([
      ['2026-11-20', 'claude-haiku-5-5', 'standard', 202],
      ['2026-11-20', 'claude-opus-5-5', 'fast', 3_030],
      ['2026-11-20', 'claude-opus-5-5', 'standard', 1_010],
      ['2026-11-21', 'claude-haiku-5-5', 'standard', 505],
      ['2026-11-21', 'claude-opus-5-5', 'standard', 4_040],
    ]);
    expect(later.pieces.every((p) => p.keyString === bucketKeyString(p.key))).toBe(true);
  });

  it('charges each key only against its own watermark', () => {
    const sent = { [bucketKeyString(OPUS)]: turn(1_000, 10), [bucketKeyString(HAIKU)]: turn(200, 2) };
    const { later } = splitBucketedDelta(parsed, sent);
    expect(byPiece(later.pieces)).toEqual([
      ['2026-11-20', 'claude-opus-5-5', 'fast', 3_030],
      ['2026-11-21', 'claude-haiku-5-5', 'standard', 505],
      ['2026-11-21', 'claude-opus-5-5', 'standard', 4_040],
    ]);
    // Recording `record` leaves nothing outstanding.
    expect(splitBucketedDelta(parsed, later.record).later.pieces).toEqual([]);
    expect(sumByKey(later.record).totalTokens).toBe(parsed.totalTokens);
  });

  it('keeps ledger keys the transcript no longer has', () => {
    const gone = bucketKeyString(makeBucketKey({ model: 'retired-model' }));
    const { later } = splitBucketedDelta(parsed, { [gone]: turn(50) });
    expect(later.record[gone]).toEqual(turn(50));
  });

  it('cuts every key at a connection', () => {
    const { earlier, later } = splitBucketedDelta(parsed, {}, '2026-11-20T10:30:00.000Z');
    expect(byPiece(earlier.pieces)).toEqual([
      ['2026-11-20', 'claude-haiku-5-5', 'standard', 202],
      ['2026-11-20', 'claude-opus-5-5', 'standard', 1_010],
    ]);
    expect(later.pieces.every((p) => p.startedAt >= '2026-11-20T10:30:00.000Z')).toBe(true);
    expect(earlier.pieces.reduce((n, p) => n + p.totalTokens, 0) + later.pieces.reduce((n, p) => n + p.totalTokens, 0)).toBe(
      parsed.totalTokens
    );
  });
});

// Ledger records from before #19 hold one flat total per session.
describe('allocateWatermarkByTime', () => {
  it('attributes a flat watermark to the earliest responses, key by key', () => {
    const byKey = allocateWatermarkByTime(parsed.entries, turn(1_000 + 200 + 1_500, 10 + 2 + 15));
    expect(byKey[bucketKeyString(OPUS)].totalTokens).toBe(1_010);
    expect(byKey[bucketKeyString(HAIKU)].totalTokens).toBe(202);
    expect(byKey[bucketKeyString(OPUS_FAST)].totalTokens).toBe(1_515);
  });

  it('sends exactly what the flat record had not, once converted', () => {
    const flat = turn(1_000 + 200, 10 + 2);
    const { later } = splitBucketedDelta(parsed, allocateWatermarkByTime(parsed.entries, flat));
    expect(later.pieces.reduce((n, p) => n + p.totalTokens, 0)).toBe(parsed.totalTokens - flat.totalTokens);
    expect(later.pieces.some((p) => p.date === '2026-11-20' && p.key.speed === 'standard')).toBe(false);
  });

  it('allocates no more than the transcript holds', () => {
    const byKey = allocateWatermarkByTime(parsed.entries, turn(1_000_000));
    expect(sumByKey(byKey).inputTokens).toBe(parsed.inputTokens);
  });
});

describe('deriveEventId', () => {
  // Two keys on one day can carry identical amounts against identical
  // watermarks; they are still two events.
  it('tells apart pieces that differ only by key', () => {
    const piece = { date: '2026-11-20', ...turn(100) };
    const a = deriveEventId('claude_code', 's', { ...piece, keyString: bucketKeyString(OPUS) }, turn(0));
    const b = deriveEventId('claude_code', 's', { ...piece, keyString: bucketKeyString(HAIKU) }, turn(0));
    expect(a).not.toBe(b);
    expect(deriveEventId('claude_code', 's', { ...piece, keyString: bucketKeyString(OPUS) }, turn(0))).toBe(a);
  });
});
