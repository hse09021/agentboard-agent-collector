/**
 * Per-day token bucketing for hook scripts.
 *
 * Why this exists
 * ---------------
 * Uploads are delta-based: each invocation re-parses the whole session and sends
 * only what accrued since the last upload. But the event carried a single
 * `started_at` taken from the session's FIRST timestamp — so a session created
 * yesterday and resumed today reported today's tokens with yesterday's
 * `started_at`, and the server (which derives `usage_date` from `started_at`)
 * filed them under yesterday.
 *
 * The fix: parsers accumulate tokens into one bucket per calendar day, and
 * `splitDeltaByDate` turns the cumulative buckets plus the already-sent totals
 * into one delta per day. Each day is uploaded as its own event, stamped with a
 * timestamp that actually falls inside that day.
 *
 * Buckets are keyed on the UTC date because that is exactly how the server
 * derives `usage_date` (`toDateString` in core-api normalize-event.ts). Bucketing
 * on any other rule would have the collector and the server disagree about which
 * day a piece of the split belongs to.
 *
 * Privacy: operates on counts and timestamps only.
 */

import { computeDelta } from './config.mjs';

export const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
  'totalTokens',
];

function toNN(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Add one turn's token counts to the bucket for the day its timestamp falls in.
 *
 * @param {Map<string, object>} buckets - keyed by YYYY-MM-DD (UTC)
 * @param {string} isoTs - ISO-8601 UTC timestamp of the turn
 * @param {object} tokens - per-field counts. `totalTokens` must already be the
 *   source's own total (Claude sums all four fields, Codex excludes the cached
 *   part of input), so this helper never has to know each source's rules.
 */
export function addToDayBucket(buckets, isoTs, tokens) {
  const date = isoTs.slice(0, 10);
  let bucket = buckets.get(date);
  if (!bucket) {
    bucket = {
      date,
      startedAt: isoTs,
      endedAt: isoTs,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    };
    buckets.set(date, bucket);
  }
  if (isoTs < bucket.startedAt) bucket.startedAt = isoTs;
  if (isoTs > bucket.endedAt) bucket.endedAt = isoTs;
  for (const field of TOKEN_FIELDS) {
    bucket[field] += toNN(tokens[field]);
  }
  return bucket;
}

/** Map -> date-ascending array. Ascending order is what splitDeltaByDate needs. */
export function sortDayBuckets(buckets) {
  return [...buckets.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

/**
 * Merge per-day bucket lists (Claude folds each subagent transcript's buckets
 * into the parent session's). Returns a fresh date-ascending array; inputs are
 * not mutated.
 */
export function mergeDayBuckets(...lists) {
  const buckets = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const bucket of list) {
      const existing = buckets.get(bucket.date);
      if (!existing) {
        buckets.set(bucket.date, { ...bucket });
        continue;
      }
      if (bucket.startedAt < existing.startedAt) existing.startedAt = bucket.startedAt;
      if (bucket.endedAt > existing.endedAt) existing.endedAt = bucket.endedAt;
      for (const field of TOKEN_FIELDS) {
        existing[field] += toNN(bucket[field]);
      }
    }
  }
  return sortDayBuckets(buckets);
}

/**
 * Split the not-yet-uploaded part of a session across the days it happened on.
 *
 * `alreadySent` is a flat cumulative total with no day breakdown — that is all
 * the ledger has ever stored, and keeping it that way means existing
 * `hook-sent.json` files keep working untouched. It needs no breakdown: whatever
 * was uploaded before was, chronologically, the session's EARLIEST tokens, so
 * charging it against the buckets in date order reconstructs the split exactly.
 * Each field is charged independently, mirroring `computeDelta`.
 *
 * @param {Array<object>} buckets - cumulative per-day buckets, date-ascending
 * @param {object} alreadySent - cumulative totals already uploaded
 * @returns {Array<object>} one entry per day that has new tokens, date-ascending
 */
export function splitDeltaByDate(buckets, alreadySent) {
  if (!Array.isArray(buckets) || buckets.length === 0) return [];

  const unallocated = {};
  for (const field of TOKEN_FIELDS) {
    unallocated[field] = toNN(alreadySent?.[field]);
  }

  const pieces = [];
  for (const bucket of buckets) {
    const piece = {
      date: bucket.date,
      startedAt: bucket.startedAt,
      endedAt: bucket.endedAt,
    };
    for (const field of TOKEN_FIELDS) {
      const have = toNN(bucket[field]);
      const charged = Math.min(have, unallocated[field]);
      unallocated[field] -= charged;
      piece[field] = have - charged;
    }
    if (piece.totalTokens > 0) pieces.push(piece);
  }
  return pieces;
}

/**
 * What every hook entry point actually calls: the day-split of a parsed
 * session's outstanding delta, with a safety net.
 *
 * The net matters because the parsers are the only source of `byDate`. If one
 * ever returns a session without it (an unexpected shape, a partially written
 * transcript with no timestamps at all), silently returning [] would drop those
 * tokens forever — the ledger would still advance on the next upload. So a
 * session with no day breakdown falls back to the pre-split behaviour: one flat
 * delta on the session's own timestamps. Less accurate, never lossy.
 */
export function splitSessionDelta(parsed, alreadySent) {
  const hasBuckets = Array.isArray(parsed?.byDate) && parsed.byDate.length > 0;
  if (hasBuckets) return splitDeltaByDate(parsed.byDate, alreadySent);

  const delta = computeDelta(parsed, alreadySent);
  if (delta.totalTokens <= 0) return [];
  const startedAt = parsed?.startedAt ?? new Date().toISOString();
  return [
    {
      date: startedAt.slice(0, 10),
      startedAt,
      endedAt: parsed?.endedAt ?? startedAt,
      ...delta,
    },
  ];
}

/**
 * Total tokens across a split, for logging and "did anything accrue" checks.
 */
export function sumPieceTokens(pieces) {
  return pieces.reduce((sum, piece) => sum + toNN(piece.totalTokens), 0);
}
