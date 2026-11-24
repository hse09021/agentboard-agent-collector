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
import { bucketKeyString, makeBucketKey } from './usage-buckets.mjs';

// `cacheCreation5mTokens` + `cacheCreation1hTokens` are a breakdown OF
// `cacheCreationTokens`, not additions to it — they are deliberately excluded
// from `totalTokens` so the total keeps meaning what it always did. They are
// carried through the split because the two TTLs are priced differently
// (1.25x input for 5-minute writes, 2x for 1-hour), and collapsing them into
// one number is why cache-heavy sessions were costed at zero.
//
// `cacheWriteInputTokens` is Codex's `cache_write_input_tokens`, which OpenAI
// bills from GPT-6.x on. Whether it is already inside Codex's input_tokens is
// not known, so it is carried on its own and never added to `totalTokens` or
// subtracted from input; the server decides once it has a price for it.
export const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheCreation5mTokens',
  'cacheCreation1hTokens',
  'cacheReadTokens',
  'cacheWriteInputTokens',
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
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      cacheWriteInputTokens: 0,
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
 * Day buckets for a list of per-response entries ({ts, turn}), date-ascending.
 */
export function bucketEntriesByDay(entries) {
  const buckets = new Map();
  for (const { ts, turn } of entries) addToDayBucket(buckets, ts, turn);
  return sortDayBuckets(buckets);
}

function zeroTotals() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function normalizeTotals(totals) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, toNN(totals?.[field])]));
}

function sumBuckets(buckets) {
  const totals = zeroTotals();
  for (const bucket of buckets) {
    for (const field of TOKEN_FIELDS) totals[field] += toNN(bucket[field]);
  }
  return totals;
}

/** Field-wise sum of a {keyString: totals} map — a session's flat total. */
export function sumByKey(byKey) {
  return sumBuckets(Object.values(byKey ?? {}));
}

const byTime = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

/**
 * Spread a flat session watermark over bucket keys.
 *
 * Ledger records written before #19 hold one total per session. Under the
 * same premise as splitDeltaByDate — what was sent is the session's earliest
 * tokens — charging that total against the responses in time order, field by
 * field, says how much of it each key already carried. Whatever exceeds the
 * transcript (one that shrank, say) is simply not allocated: it was already
 * sent, and allocating it would only hold back new tokens.
 *
 * @param {Array<{ts: string, turn: object, key?: object}>} entries
 * @param {object} totals - the flat watermark
 * @returns {Record<string, object>} keyString -> totals
 */
export function allocateWatermarkByTime(entries, totals) {
  const remaining = normalizeTotals(totals);
  const byKey = {};
  for (const entry of [...entries].sort(byTime)) {
    const into = (byKey[bucketKeyString(entry.key)] ??= zeroTotals());
    for (const field of TOKEN_FIELDS) {
      const charged = Math.min(toNN(entry.turn[field]), remaining[field]);
      remaining[field] -= charged;
      into[field] += charged;
    }
  }
  return byKey;
}

/**
 * A session's outstanding delta, per bucket key (see usage-buckets.mjs) and
 * calendar day, optionally cut at the moment its directory was connected and
 * optionally without what came before `since`.
 *
 * Each key is its own small session: its responses become day buckets and
 * splitDeltaByDate charges that key's watermark against them. Every piece
 * carries its `key` and `keyString`, so it becomes an event priced as that
 * model, speed and prompt-size tier.
 *
 * Each key's responses fall into up to three windows, in time order:
 *
 *   withheld  before `since` (and before `splitAt`) — never sent (#23: a
 *             directory tracked later sends only what came after)
 *   earlier   from `since` to `splitAt` — the pre-connect side of a hand-off
 *   later     everything else
 *
 * and, field by field, with `sent` the key's watermark:
 *
 *   earlier  = window − (sent − withheld)                  (not yet sent)
 *   later    = cumulative − max(sent, withheld + earlier)
 *
 * Both are splitDeltaByDate over the windows in time order, charged with the
 * watermark that covers everything before them — that premise (what was sent
 * is the earliest tokens) is what makes this exact. Withheld tokens count as
 * covered, so they are never sent by either side. Post-connect tokens an older
 * collector already sent to the community server are absorbed by the max: they
 * cannot be recalled, but are not sent twice.
 *
 * Without `splitAt` there is a single (`later`) side after the withheld window.
 *
 * Each side returns its pieces, the per-key watermark their event ids derive
 * from, and `record` — the per-key ledger once that side has landed. Keys the
 * ledger knows but the transcript no longer has are carried over unchanged.
 *
 * Without per-response entries (an unexpected parse result) there is nothing
 * to key or cut by: the whole flat delta becomes one key under the session's
 * model, on the `later` side.
 *
 * @param {object} parsed - parser output carrying `entries`
 * @param {Record<string, object>} sentByKey - per-key totals already uploaded
 * @param {{since?: string|null, splitAt?: string|null}} [cuts] - ISO-8601
 *   instants: withhold what came before `since`; split the rest at `splitAt`
 * @returns {{earlier: object|null, later: object}} each
 *   `{pieces, watermarks: {keyString: totals}, record: {keyString: totals}}`;
 *   `earlier` is null without `splitAt`
 */
export function splitBucketedDelta(parsed, sentByKey, { since = null, splitAt = null } = {}) {
  const earlier = splitAt ? { pieces: [], watermarks: {}, record: { ...sentByKey } } : null;
  const later = { pieces: [], watermarks: {}, record: { ...sentByKey } };

  if (!Array.isArray(parsed?.entries)) {
    const key = makeBucketKey({ model: parsed?.model });
    const keyString = bucketKeyString(key);
    const sent = sumByKey(sentByKey);
    later.pieces = splitSessionDelta(parsed, sent).map((piece) => ({ ...piece, key, keyString }));
    later.watermarks = { [keyString]: sent };
    later.record = { [keyString]: normalizeTotals(parsed) };
    return { earlier, later };
  }

  const groups = new Map();
  for (const entry of parsed.entries) {
    const keyString = bucketKeyString(entry.key);
    if (!groups.has(keyString)) groups.set(keyString, { key: makeBucketKey(entry.key ?? {}), entries: [] });
    groups.get(keyString).entries.push(entry);
  }

  const splitCut = splitAt ? Date.parse(splitAt) : Infinity;
  // Withholding never reaches past a connection: what came after it belongs to
  // the organization whatever the community side's `since` says.
  const withholdCut = since ? Math.min(Date.parse(since), splitCut) : -Infinity;
  const windowOf = (entry) => {
    const ts = Date.parse(entry.ts);
    if (ts < withholdCut) return 0;
    if (ts < splitCut) return 1;
    return 2;
  };
  const maxOf = (a, b) => Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(a[f], b[f])]));

  for (const [keyString, { key, entries }] of groups) {
    const sent = normalizeTotals(sentByKey?.[keyString]);
    const tag = (pieces) => pieces.map((piece) => ({ ...piece, key, keyString }));

    const windows = [[], [], []];
    for (const entry of entries) windows[windowOf(entry)].push(entry);
    const [withheld, middle, rest] = windows.map(bucketEntriesByDay);

    // Everything before each side, as a watermark.
    const beforeMiddle = maxOf(sent, sumBuckets(withheld));
    const beforeRest = maxOf(sent, sumBuckets([...withheld, ...middle]));
    const cumulative = sumBuckets([...withheld, ...middle, ...rest]);

    if (!splitAt) {
      // No connection: `middle` and `rest` are one window, sent together.
      later.pieces.push(...tag(splitDeltaByDate([...withheld, ...middle, ...rest], beforeMiddle)));
      later.watermarks[keyString] = beforeMiddle;
      later.record[keyString] = cumulative;
      continue;
    }

    earlier.pieces.push(...tag(splitDeltaByDate([...withheld, ...middle], beforeMiddle)));
    earlier.watermarks[keyString] = beforeMiddle;
    earlier.record[keyString] = beforeRest;

    later.pieces.push(...tag(splitDeltaByDate([...withheld, ...middle, ...rest], beforeRest)));
    later.watermarks[keyString] = beforeRest;
    later.record[keyString] = cumulative;
  }

  // Day first, then key: the order events are built and uploaded in.
  const order = (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.keyString < b.keyString ? -1 : a.keyString > b.keyString ? 1 : 0;
  later.pieces.sort(order);
  earlier?.pieces.sort(order);
  return { earlier, later };
}

/**
 * Total tokens across a split, for logging and "did anything accrue" checks.
 */
export function sumPieceTokens(pieces) {
  return pieces.reduce((sum, piece) => sum + toNN(piece.totalTokens), 0);
}
