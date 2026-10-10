/**
 * Resolves everything a hook needs to upload: which server, with which
 * credential, as which device.
 *
 * Every hook entry point needs the same five steps (load config, read the
 * session's pin, resolve the route, fetch that route's credential, bail out
 * cleanly if anything is missing). Doing it in one place keeps Claude Code and
 * Codex from drifting apart — a divergence there would mean one tool routes
 * correctly and the other quietly ships data to the wrong server.
 */

import { loadConfigV2, loadRouteCredential, getSentRoute } from './config.mjs';
import { resolveRoute } from './routing.mjs';
import { ensureFreshToken } from './token-refresh.mjs';
import { recordAuthFailure } from './auth-failure.mjs';
import { ensureFreshProjectCredential } from './project-credential.mjs';
import { uploadEvents } from './transport.mjs';

/**
 * @param {{source: string, sessionId: string, cwd?: string|null}} input
 * @returns {{
 *   ok: true, route: object, apiBaseUrl: string, deviceId: string,
 *   token: string, config: object, pinnedRoute: string|null
 * } | { ok: false, reason: string }}
 */
export function resolveUploadContext({ source, sessionId, cwd }) {
  const config = loadConfigV2();
  if (!config) return { ok: false, reason: 'no config' };

  const pinnedRoute = getSentRoute(source, sessionId);
  const route = resolveRoute({ config, cwd, pinnedRouteId: pinnedRoute });

  if (route.kind === 'blocked') {
    // The binding this session was pinned to is gone. Falling back to another
    // server would ship one organization's telemetry somewhere it was never
    // meant to go; the tokens stay in the ledger and are recovered if the
    // binding comes back.
    return { ok: false, reason: `session pinned to a missing route (${pinnedRoute})` };
  }

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
    pinnedRoute,
  };
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
      source: input.source,
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
