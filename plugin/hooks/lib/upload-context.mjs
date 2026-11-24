/**
 * Resolves everything a hook needs to upload: which server, with which
 * credential, as which device — and, for a session handed off mid-flight, which
 * of its tokens go to which server.
 *
 * Every hook entry point needs the same steps (load config, read the session's
 * pin, resolve the route, fetch that route's credential, compute the delta,
 * upload, record it). Doing it in one place keeps Claude Code and Codex from
 * drifting apart — a divergence there would mean one tool routes correctly and
 * the other quietly ships data to the wrong server.
 */

import {
  loadConfigV2,
  loadRouteCredential,
  getSentRoute,
  getSentRecord,
  markTotalsSent,
  markTotalsSentMonotonic,
  markTotalsWithheld,
} from './config.mjs';
import { resolveRoute } from './routing.mjs';
import { ensureFreshToken } from './token-refresh.mjs';
import { recordAuthFailure } from './auth-failure.mjs';
import { ensureFreshProjectCredential } from './project-credential.mjs';
import { uploadEvents } from './transport.mjs';
import { allocateWatermarkByTime, splitBucketedDelta, sumByKey, sumPieceTokens } from './daily-split.mjs';
import { bucketKeyString, makeBucketKey } from './usage-buckets.mjs';
import { assertNoForbiddenFields, sanitizeRawOutput } from './forbidden-data-guard.mjs';

/**
 * Where a session's usage goes, decided without touching any credential.
 *
 * `route` is where new usage goes. For a hand-off (see resolveRoute) `from` is
 * the community route that keeps the tokens from before `splitAt` — null when
 * "listed" scope sends them nowhere. A route may carry `since`: what came
 * before it is never sent there.
 *
 * `kind: 'skip'` means nothing is sent for this session at all ("listed" scope,
 * cwd not tracked); `route` is then null. uploadSessionDelta records its tokens
 * as never to be sent.
 *
 * Fails only when nothing could be sent at all: a pinned route that is gone,
 * or no credential for any route involved.
 *
 * @param {{source: string, sessionId: string, cwd?: string|null}} input
 *   `sessionId` is the session whose pin decides the route
 */
export function resolveUploadPlan({ source, sessionId, cwd }) {
  const config = loadConfigV2();
  if (!config) return { ok: false, reason: 'no config' };

  const pinnedRoute = getSentRoute(source, sessionId);
  const resolved = resolveRoute({ config, cwd, pinnedRouteId: pinnedRoute });

  if (resolved.kind === 'blocked') {
    // The binding this session was pinned to is gone. Falling back to another
    // server would ship one organization's telemetry somewhere it was never
    // meant to go; the tokens stay in the ledger and are recovered if the
    // binding comes back.
    return { ok: false, reason: `session pinned to a missing route (${pinnedRoute})` };
  }

  if (resolved.kind === 'skip') {
    return { ok: true, kind: 'skip', config, pinnedRoute, route: null, from: null, splitAt: null };
  }

  const route = resolved.kind === 'handoff' ? resolved.to : resolved;
  const from = resolved.kind === 'handoff' ? resolved.from : null;

  if (![route, from].some((r) => r && loadRouteCredential(r.credentialRef))) {
    return { ok: false, reason: `no credential for route ${route.routeId}` };
  }

  return {
    ok: true,
    kind: resolved.kind,
    config,
    pinnedRoute,
    route,
    from,
    splitAt: resolved.kind === 'handoff' ? resolved.splitAt : null,
  };
}

function contextForRoute(config, route) {
  const deviceId = route.server.device_id ?? config.device_id;
  const token = loadRouteCredential(route.credentialRef);

  if (!token) return { ok: false, reason: `no credential for route ${route.routeId}` };
  if (!deviceId) return { ok: false, reason: `no device id for route ${route.routeId}` };

  return {
    ok: true,
    route,
    apiBaseUrl: route.server.api_base_url,
    deviceId,
    token,
    config,
  };
}

/**
 * @param {{source: string, sessionId: string, cwd?: string|null}} input
 * @returns {{
 *   ok: true, route: object, apiBaseUrl: string, deviceId: string,
 *   token: string, config: object, pinnedRoute: string|null
 * } | { ok: false, reason: string }} the context for the route new usage goes
 *   to (for a hand-off, the organization's)
 */
export function resolveUploadContext(input) {
  const plan = resolveUploadPlan(input);
  if (!plan.ok) return plan;
  if (plan.kind === 'skip') return { ok: false, reason: 'directory not tracked (listed scope)' };
  const context = contextForRoute(plan.config, plan.route);
  return context.ok ? { ...context, pinnedRoute: plan.pinnedRoute } : context;
}

/**
 * resolveUploadContext, plus a rotated access token or a renewed project
 * credential when one is due.
 *
 * The two routes renew separately, so the branch is explicit rather than
 * incidental. Both rotate an access/refresh pair now, but they are different
 * servers' tokens: the DEFAULT route (`credentialRef === null`) is `.token`
 * from the server the user logged into, a connected project's `.cred` is from
 * its organization's server. A refresh token sent to the other server is
 * refused, but only after its operator has seen it. So the default route goes
 * through ensureFreshToken (`.token`, `.token.lock`) and a project through
 * ensureFreshProjectCredential (its `.cred`, its own lock), each to its own
 * route's api_base_url, and neither path ever touches the other's files.
 *
 * Never fails the upload over a refresh problem: a transient failure keeps the
 * current token (it is usually still valid), and a permanently dead refresh
 * token is recorded for the next CLI run to surface, because a hook has no
 * stdout anyone reads.
 *
 * @param {{source: string, sessionId: string, cwd?: string|null}} input
 * @param {(msg: string) => void} [log]
 */
export async function resolveUploadContextWithRefresh(input, log = () => {}) {
  const context = resolveUploadContext(input);
  if (!context.ok) return context;
  return refreshContext(context, input.source, log);
}

async function refreshContext(context, source, log) {
  if (context.route.credentialRef !== null) {
    const renewal = await ensureFreshProjectCredential({
      apiBaseUrl: context.apiBaseUrl,
      credentialRef: context.route.credentialRef,
      credential: context.token,
      deviceId: context.deviceId,
    });
    if (renewal.kind !== 'current') {
      log(`project credential ${renewal.kind}${renewal.reason ? `: ${renewal.reason}` : ''}`);
    }
    return { ...context, token: renewal.credential };
  }

  const outcome = await ensureFreshToken(context.apiBaseUrl);

  if (outcome.kind === 'refreshed') {
    log(`token refreshed (expires_at=${outcome.bundle.access_expires_at ?? 'unknown'})`);
    return { ...context, token: outcome.bundle.access };
  }
  if (outcome.kind === 'current') {
    return { ...context, token: outcome.bundle.access };
  }
  if (outcome.kind === 'reauth_required') {
    // Either the refresh token is dead (90+ days offline, a revoked family) or
    // the stored token predates refresh support and is nearing expiry. Upload
    // anyway: the access token may have life left, and a 401 here costs one
    // request. The reason carries the distinction to the CLI.
    log(`re-login required: ${outcome.reason}`);
    recordAuthFailure({
      reason: outcome.reason,
      source,
      apiBaseUrl: context.apiBaseUrl,
    });
    return context;
  }

  log(`refresh unavailable: ${outcome.reason} — continuing with current token`);
  return context;
}

/**
 * Whether an upload failed because the server refused the bearer token.
 *
 * @param {unknown} err error thrown by uploadEvents
 */
export function isUnauthorizedError(err) {
  return /^HTTP 401\b/.test(err?.message ?? '');
}

/**
 * Uploads with the context's credential. When a connected project's server
 * answers 401, rotates that project's credential once and retries once — an
 * access token lasts an hour, so one that expired between the pre-emptive
 * check and the upload is routine. Never loops.
 *
 * The default route keeps its old behaviour (no retry here): a 401 there
 * surfaces as an upload failure exactly as before.
 *
 * On a retry `context.token` is replaced, so anything the caller sends next
 * (a device re-registration, say) uses the credential that worked.
 *
 * @param {{route: {credentialRef: string|null}, apiBaseUrl: string, deviceId: string, token: string}} context
 * @param {object[]} events
 * @param {(msg: string) => void} [log]
 * @param {typeof uploadEvents} [uploader]
 */
export async function uploadWithContext(context, events, log = () => {}, uploader = uploadEvents) {
  try {
    return await uploader(context.apiBaseUrl, context.token, context.deviceId, events);
  } catch (err) {
    if (!isUnauthorizedError(err) || context.route.credentialRef === null) throw err;

    const renewal = await ensureFreshProjectCredential(
      {
        apiBaseUrl: context.apiBaseUrl,
        credentialRef: context.route.credentialRef,
        credential: context.token,
        deviceId: context.deviceId,
      },
      { force: true },
    );
    log(`upload got 401; project credential ${renewal.kind}${renewal.reason ? `: ${renewal.reason}` : ''}`);
    if (renewal.credential === context.token) throw err;

    context.token = renewal.credential;
    return uploader(context.apiBaseUrl, context.token, context.deviceId, events);
  }
}

/**
 * The legs a session's outstanding delta splits into, in upload order.
 *
 * Ordinarily one leg: the whole delta to the plan's route. A hand-off has two,
 * the pre-connect tail to the community server first and the rest to the
 * organization's (see splitBucketedDelta). Each leg carries, per bucket key,
 * the watermark its event ids derive from, and the ledger to record once it
 * lands. That is what makes a retry after a partial failure recompute exactly
 * the same thing: after the first leg each key sits at `max(sent, before)` on
 * the default route, so the next attempt has no tail left and an identical
 * second leg, ids included.
 *
 * Tokens before the community route's `since` ("listed" scope) are withheld:
 * neither leg sends them, and whichever leg lands records them as covered. A
 * hand-off whose `from` is null sends its pre-connect tail nowhere at all.
 */
function planLegs(plan, parsed, sentByKey) {
  if (!parsed) return [{ route: plan.route, pieces: [], watermarks: {}, record: null, primary: true }];

  const handoff = plan.kind === 'handoff';
  const community = handoff ? plan.from : plan.route.credentialRef === null ? plan.route : null;
  const { earlier, later } = splitBucketedDelta(parsed, sentByKey, {
    // A null `from` withholds the whole pre-connect side.
    since: handoff && !plan.from ? plan.splitAt : (community?.since ?? null),
    splitAt: handoff ? plan.splitAt : null,
  });
  const legs = [];
  if (earlier && plan.from) legs.push({ route: plan.from, ...earlier, primary: false });
  legs.push({ route: plan.route, ...later, primary: true });
  return legs;
}

/**
 * The ledger's per-key watermarks. A record from before #19 holds one flat
 * total; it is spread over this session's keys by time (the tokens it covered
 * were the earliest), and stored per key by the next upload.
 */
function sentByBucket(record, parsed, log) {
  if (record.buckets) return record.buckets;
  if (Array.isArray(parsed?.entries)) {
    const byKey = allocateWatermarkByTime(parsed.entries, record.totals);
    if (record.totals.totalTokens > 0) {
      log(`ledger spread over ${Object.keys(byKey).length} bucket key(s) by time (was flat)`);
    }
    return byKey;
  }
  return { [bucketKeyString(makeBucketKey({ model: parsed?.model }))]: record.totals };
}

function describePieces(pieces) {
  return (
    `${sumPieceTokens(pieces)} in ${pieces.length} piece(s) ` +
    `[${pieces.map((p) => `${p.date}/${p.key?.model ?? '?'}:${p.totalTokens}`).join(' ')}]`
  );
}

/**
 * Upload what a session has accrued since its last upload, and record it.
 *
 * The caller must already hold the session lock where it takes one: the
 * ledger is read here, and a second reader would compute an overlapping delta.
 *
 * Steps: read the ledger, split the delta into legs (planLegs) — per bucket
 * key and day, and at the connection for a hand-off — resolve each
 * leg's credential (refreshing it if due), build every event and run the
 * privacy guard over all of them, then upload leg by leg, recording each one
 * in the ledger as soon as it lands. Nothing is uploaded if the guard rejects
 * any event.
 *
 * A leg without a credential is skipped and never sent anywhere else. Skipping
 * the organization's leg leaves its tokens in the ledger for when the
 * credential is back. Skipping the community tail of a hand-off gives it up
 * once the organization's leg lands — it has nowhere else to go.
 *
 * The usage-limit snapshot rides on the last event of the route new usage goes
 * to, since that is where it was measured; with no tokens to carry it, it goes
 * alone in a snapshot-only event.
 *
 * Upload errors are thrown as they come, after any earlier leg has been
 * recorded, so the caller's existing handling (revoked device, re-login) still
 * applies.
 *
 * @param {object} plan - from resolveUploadPlan (must be ok)
 * @param {object} opts
 * @param {string} opts.source
 * @param {string} opts.ledgerKey - the ledger entry whose totals these are (a
 *   session id, or `sub:<agentId>` for a Codex subagent)
 * @param {object|null} opts.parsed - cumulative parse result
 * @param {(deviceId: string, piece: object, watermark: object) => object} opts.buildEvent
 *   one event per piece; `piece.key` is its bucket key and `watermark` that
 *   key's ledger value
 * @param {object|null} [opts.snapshot] - usage-limit snapshot
 * @param {(deviceId: string) => object} [opts.buildSnapshotOnlyEvent]
 * @param {boolean} [opts.monotonic] - record with markTotalsSentMonotonic (the sweep)
 * @param {(ctx: object, events: object[]) => Promise<object>} [opts.upload]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{
 *   status: 'nothing' | 'sent' | 'held' | 'skipped' | 'untracked',
 *   tokens: number,
 *   uploads: Array<{routeId: string, events: object[], verdict: object}>,
 *   skipped: Array<{routeId: string, reason: string, tokens: number}>,
 * }>}
 */
export async function uploadSessionDelta(plan, opts) {
  const {
    source,
    ledgerKey,
    parsed,
    buildEvent,
    snapshot = null,
    buildSnapshotOnlyEvent,
    monotonic = false,
    log = () => {},
  } = opts;
  const upload = opts.upload ?? ((ctx, events) => uploadWithContext(ctx, events, log));
  const record = monotonic ? markTotalsSentMonotonic : markTotalsSent;

  const sentRecord = getSentRecord(source, ledgerKey);

  // "listed" scope, cwd not tracked: nothing is sent, not even a usage
  // snapshot, and what the session has used so far is recorded as never to be
  // sent — so untracking stops it at once, and tracking the directory later or
  // switching back to "all" never ships what accrued meanwhile.
  if (plan.kind === 'skip') {
    if (parsed) {
      const { later } = splitBucketedDelta(parsed, sentByBucket(sentRecord, parsed, log));
      markTotalsWithheld(source, ledgerKey, sumByKey(later.record), later.record);
      log(`SKIP: directory not tracked (listed scope) — ${parsed.totalTokens} tokens withheld`);
    }
    return { status: 'untracked', tokens: 0, uploads: [], skipped: [] };
  }

  const legs = planLegs(plan, parsed, parsed ? sentByBucket(sentRecord, parsed, log) : {});
  const alreadySent = sentRecord.totals.totalTokens;

  if (plan.kind === 'handoff' && parsed) {
    log(
      `handoff at ${plan.splitAt}: ${legs[0].route.routeId} ${describePieces(legs[0].pieces)}, ` +
        `${legs[1].route.routeId} ${describePieces(legs[1].pieces)} ` +
        `(cumulative=${parsed.totalTokens}, alreadySent=${alreadySent})`
    );
  } else if (parsed) {
    log(
      `delta totalTokens=${describePieces(legs[0].pieces)} ` +
        `(cumulative=${parsed.totalTokens}, alreadySent=${alreadySent})`
    );
  }

  const result = { status: 'nothing', tokens: 0, uploads: [], skipped: [] };

  // Resolve credentials and build every event before uploading anything, so a
  // guard failure can never leave a hand-off half done.
  const batches = [];
  for (const leg of legs) {
    const carriesSnapshot = leg.primary && snapshot && buildSnapshotOnlyEvent;
    if (leg.pieces.length === 0 && !carriesSnapshot) continue;

    const resolved = contextForRoute(plan.config, leg.route);
    if (!resolved.ok) {
      const tokens = sumPieceTokens(leg.pieces);
      log(`SKIP ${leg.route.routeId}: ${resolved.reason} (${tokens} tokens not sent)`);
      result.skipped.push({ routeId: leg.route.routeId, reason: resolved.reason, tokens });
      continue;
    }
    const ctx = await refreshContext(resolved, source, log);

    const events =
      leg.pieces.length > 0
        ? leg.pieces.map((piece) => buildEvent(ctx.deviceId, piece, leg.watermarks[piece.keyString]))
        : [buildSnapshotOnlyEvent(ctx.deviceId)];
    // A point-in-time reading of the account's rate limits, not per-day data —
    // the most recent event only, never each.
    if (carriesSnapshot) {
      events[events.length - 1].usage_snapshot = { ...snapshot, raw: sanitizeRawOutput(snapshot.raw) };
    }
    batches.push({ leg, ctx, events });
  }

  // The privacy guard runs on the exact objects being uploaded, right before
  // the network calls. Throws ForbiddenDataError.
  for (const { events } of batches) {
    for (const event of events) assertNoForbiddenFields(event);
  }

  if (batches.length === 0) {
    if (result.skipped.length > 0) result.status = 'skipped';
    return result;
  }

  for (const { leg, ctx, events } of batches) {
    const tokens = events.reduce((n, e) => n + (e.total_tokens ?? 0), 0);
    log(`uploading ${events.length} event(s) to ${leg.route.routeId} total_tokens=${tokens}`);

    // One batch per leg, so a partial failure cannot advance the ledger past
    // days that never landed.
    const verdict = await upload(ctx, events);

    if (verdict && verdict.parsed) {
      log(
        `server verdict accepted=${verdict.accepted} duplicates=${verdict.duplicates} ` +
          `rejected=${verdict.rejected} reasons=${JSON.stringify(verdict.reasons)}`
      );
    }
    result.uploads.push({ routeId: leg.route.routeId, events, verdict });

    // A 2xx is not proof that the events landed — the server reports
    // per-event rejections inside the body. Advancing the ledger past an event
    // the server could still accept loses those tokens permanently, and the
    // next leg must not go out ahead of this one.
    if (verdict && !verdict.canAdvanceLedger) {
      result.status = 'held';
      return result;
    }

    // Record what this leg covered, pinning the session to its route. After a
    // hand-off's second leg the session is pinned to the organization, and the
    // hand-off is over.
    if (leg.pieces.length > 0) {
      record(source, ledgerKey, sumByKey(leg.record), leg.route.routeId, leg.record);
      result.tokens += tokens;
    }
    result.status = 'sent';
  }

  return result;
}
