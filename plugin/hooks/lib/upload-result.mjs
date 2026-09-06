/**
 * Classification of a batch upload response.
 *
 * The server answers 200 with a per-event breakdown
 * ({accepted, duplicates, rejected, results}), but until v0.7.0 the transport
 * never read the body — it treated any 2xx as total success and advanced the
 * delta ledger. So a response of {accepted: 0, rejected: 3} silently threw away
 * those tokens forever: the ledger had moved past them and deltas are
 * cumulative, so they were never resent.
 *
 * That mattered little against a single server that always matched the
 * collector. With self-hosted servers upgrading on the customer's own schedule,
 * version skew is permanent and bidirectional, so the loss becomes routine.
 *
 * Reject reasons the server actually emits per event are all permanent:
 * forbidden_field, invalid_schema, device_mismatch. The conditions that a retry
 * could fix (device_not_found, revoked_device) come back as 404/403 for the
 * whole batch, before the per-event loop runs.
 */

/** Retrying these cannot help — the event will be rejected identically forever. */
export const PERMANENT_REJECT_REASONS = new Set([
  'invalid_schema',
  'forbidden_field',
  'device_mismatch',
  'unknown_source',
  'invalid_token_count',
]);

/**
 * Declared by the server's type but never emitted per-event today. Handled
 * anyway so that a server which starts emitting it finds a client that already
 * behaves correctly.
 */
export const RETRIABLE_REJECT_REASONS = new Set(['revoked_device']);

/**
 * @param {unknown} body    parsed JSON response, or null when unparsable
 * @param {number} sentCount how many events were in the batch
 * @returns {{
 *   accepted: number, duplicates: number, rejected: number,
 *   permanentRejects: number, retriableRejects: number, unknownRejects: number,
 *   reasons: Record<string, number>,
 *   canAdvanceLedger: boolean,
 *   allRejected: boolean,
 *   parsed: boolean
 * }}
 */
export function classifyUploadResponse(body, sentCount) {
  const empty = {
    accepted: sentCount,
    duplicates: 0,
    rejected: 0,
    permanentRejects: 0,
    retriableRejects: 0,
    unknownRejects: 0,
    reasons: {},
    canAdvanceLedger: true,
    allRejected: false,
    parsed: false,
  };

  // An older server, a proxy that rewrites the body, or a plain empty 200 all
  // land here. Assuming success preserves the pre-v0.7.0 behaviour, which is
  // the only safe default: refusing to advance would re-upload every batch
  // forever against such a server.
  if (!body || typeof body !== 'object') return empty;

  const results = Array.isArray(body.results) ? body.results : [];
  const accepted = Number.isFinite(body.accepted) ? body.accepted : 0;
  const duplicates = Number.isFinite(body.duplicates) ? body.duplicates : 0;
  const rejected = Number.isFinite(body.rejected) ? body.rejected : 0;

  if (!results.length && rejected === 0 && accepted === 0 && duplicates === 0) {
    return empty;
  }

  const reasons = {};
  let permanentRejects = 0;
  let retriableRejects = 0;
  let unknownRejects = 0;

  for (const entry of results) {
    if (!entry || entry.status !== 'rejected') continue;
    const reason = typeof entry.reason === 'string' ? entry.reason : 'unknown';
    reasons[reason] = (reasons[reason] ?? 0) + 1;

    if (RETRIABLE_REJECT_REASONS.has(reason)) retriableRejects++;
    else if (PERMANENT_REJECT_REASONS.has(reason)) permanentRejects++;
    else unknownRejects++;
  }

  // A reason we do not recognise is treated as permanent: looping forever on an
  // unknown rejection is worse than dropping it, and the counter makes the loss
  // visible in `agentboard status` instead of silent.
  const settled = accepted + duplicates + permanentRejects + unknownRejects;

  return {
    accepted,
    duplicates,
    rejected,
    permanentRejects,
    retriableRejects,
    unknownRejects,
    reasons,
    canAdvanceLedger: retriableRejects === 0 && settled >= sentCount,
    allRejected: sentCount > 0 && accepted === 0 && duplicates === 0 && rejected >= sentCount,
    parsed: true,
  };
}
