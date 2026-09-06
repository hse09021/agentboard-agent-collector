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
