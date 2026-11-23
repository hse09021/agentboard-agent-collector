/**
 * Usage bucket keys (#19).
 *
 * The server prices an event by its single `model`. A session used to be sent
 * as one model — the last one seen for Claude, the first for Codex — so a
 * Haiku subagent inside an Opus session was billed at Opus rates, fast mode at
 * standard rates, and a request past a model's long-prompt tier at the short
 * one. Each API response now carries a bucket key, and a session's tokens are
 * summed and uploaded per key:
 *
 *   model               the response's own model
 *   speed               Claude's `usage.speed` (`standard` / `fast`). Codex
 *                       rollouts do not record the service tier, so Codex is
 *                       always `standard`.
 *   contextSizeBucket   which side of a pricing boundary the request's prompt
 *                       fell on (see CONTEXT_SIZE_BUCKETS)
 *   inferenceGeo        Claude's `usage.inference_geo` (US-only inference is
 *                       priced higher on newer models)
 *
 * Only boundaries are sent, never a price or a raw prompt size: which model
 * uses which tier is the server's decision, so the collector never has to know
 * a price, and the server learns no more about a request than its tier.
 *
 * Privacy: keys are built from model names and usage counters only.
 */

/**
 * Prompt sizes (input + cache reads + cache writes) at which some model's
 * per-token price changes:
 *   - Claude Haiku 5.5 costs 5x for a prompt over 100K tokens
 *   - OpenAI GPT-6.x and GPT-5.6 cost 2x input / 1.5x output over 272K
 * A request belongs to the first bucket whose `max` it does not exceed.
 */
export const CONTEXT_SIZE_BUCKETS = [
  { label: 'up_to_100k', max: 100_000 },
  { label: 'up_to_272k', max: 272_000 },
  { label: 'over_272k', max: Infinity },
];

export const STANDARD_SPEED = 'standard';

export function contextSizeBucket(promptTokens) {
  const n = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  return CONTEXT_SIZE_BUCKETS.find((bucket) => n <= bucket.max).label;
}

// The values come from the AI tool's own transcript and go to the server
// verbatim, so anything that is not a short identifier is dropped rather than
// forwarded.
function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? value : null;
}

/**
 * @param {{model?: string|null, speed?: unknown, contextSizeBucket?: string|null,
 *          inferenceGeo?: unknown}} fields
 */
export function makeBucketKey({ model, speed, contextSizeBucket: size, inferenceGeo }) {
  return {
    model: model ?? null,
    speed: identifier(speed) ?? STANDARD_SPEED,
    contextSizeBucket: size ?? null,
    inferenceGeo: identifier(inferenceGeo),
  };
}

/** Canonical form, used as the ledger key and in event ids. */
export function bucketKeyString(key) {
  const k = makeBucketKey(key ?? {});
  return JSON.stringify([k.model, k.speed, k.contextSizeBucket, k.inferenceGeo]);
}

/**
 * The event fields a key contributes. Unknown parts are left out rather than
 * guessed. None of the names contains a key the privacy guard forbids — the
 * issue's `prompt_size_bucket` would (it contains "prompt" and "pr"), which is
 * why the size bucket travels as `context_size_bucket`.
 */
export function bucketEventFields(key, fallbackModel) {
  const k = makeBucketKey(key ?? {});
  return {
    model: k.model ?? fallbackModel,
    speed: k.speed,
    ...(k.contextSizeBucket ? { context_size_bucket: k.contextSizeBucket } : {}),
    ...(k.inferenceGeo ? { inference_geo: k.inferenceGeo } : {}),
  };
}
