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
 * resolveUploadContext, plus a rotated access token when one is due.
 *
 * Refresh is scoped to the DEFAULT route (`credentialRef === null`, i.e. the
 * `.token` bundle). A connected project's `.cred` is a separate enrollment
 * credential that the server does not rotate and that is not part of any
 * refresh family — sending it to the refresh endpoint would be an error, and
 * worse, a confusing one to debug. So the branch is explicit rather than
 * incidental.
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

  if (context.route.credentialRef !== null) return context; // .cred route — never rotated

  const outcome = await ensureFreshToken(context.apiBaseUrl);

  if (outcome.kind === 'refreshed') {
    log(`token refreshed (expires_at=${outcome.bundle.access_expires_at ?? 'unknown'})`);
    return { ...context, token: outcome.bundle.access };
  }
  if (outcome.kind === 'current') {
    return { ...context, token: outcome.bundle.access };
  }
  if (outcome.kind === 'reauth_required') {
    // The refresh token is dead (90+ days offline, or the family was revoked).
    // Upload anyway: the access token may have a little life left, and a 401
    // here costs nothing beyond one request.
    log(`refresh rejected: ${outcome.reason} — re-login required`);
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
