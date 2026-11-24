/**
 * Directory to server routing (hook runtime).
 *
 * Mirror of src/core/routing.ts — keep the two in sync. Pure: the caller passes
 * the config and the session's pinned route, so the hook and the CLI cannot
 * disagree about where a session's data goes.
 */

import { normalizePath, isPathPrefix } from './path-normalize.mjs';

export const DEFAULT_ROUTE_ID = 'default';

/** Nothing is sent for this session: listed scope, and its cwd is not tracked. */
export const SKIP_NOT_TRACKED = Object.freeze({ kind: 'skip', reason: 'not_tracked' });

/**
 * Longest-prefix match over directory entries — bindings, or tracked dirs. Both
 * the literal and the realpath form are compared.
 */
export function matchBinding(bindings, cwd) {
  const target = normalizePath(cwd);
  if (!target) return null;

  let best = null;
  for (const binding of bindings ?? []) {
    for (const candidate of [binding.abs_dir, binding.real_dir]) {
      const dir = normalizePath(candidate);
      if (!isPathPrefix(dir, target)) continue;
      if (!best || dir.length > best.length) best = { binding, length: dir.length };
    }
  }
  return best ? best.binding : null;
}

function defaultRoute(config) {
  return {
    kind: 'send',
    routeId: DEFAULT_ROUTE_ID,
    server: config.default_server,
    credentialRef: null,
  };
}

function bindingRoute(binding) {
  return {
    kind: 'send',
    routeId: binding.credential_ref,
    server: binding.server,
    credentialRef: binding.credential_ref,
    binding,
  };
}

export function routeForId(config, routeId) {
  if (routeId === DEFAULT_ROUTE_ID) return defaultRoute(config);

  const binding = (config.bindings ?? []).find((b) => b.credential_ref === routeId);
  if (!binding) return { kind: 'blocked', reason: 'route_missing' };

  return bindingRoute(binding);
}

function validInstant(iso) {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Where an unconnected directory's usage goes: the default server, or — in
 * "listed" scope — the default server only for a tracked directory, and only
 * for what was used after it was added (`since`). Null means nowhere.
 */
function communityRoute(config, cwd) {
  if (config.default_scope !== 'listed') return defaultRoute(config);
  const tracked = matchBinding(config.tracked_dirs, cwd);
  const since = tracked ? validInstant(tracked.added_at) : null;
  return since ? { ...defaultRoute(config), since } : null;
}

export function resolveRoute({ config, cwd, pinnedRouteId }) {
  const binding = matchBinding(config.bindings, cwd);
  const community = communityRoute(config, cwd);

  // A session that has only ever gone to the community server, now working in
  // a connected directory, is handed off at the moment of connection: tokens
  // from before `connected_at` stay with the community server and everything
  // after goes to the organization's. Keeping the whole session on the
  // community server would ship the organization's work there for as long as
  // the session lives; moving the whole session would give the organization
  // the personal work that came before the connection. Splitting by time
  // honours both promises.
  //
  // Only a session pinned to the community server is handed off. An unpinned
  // one goes by cwd as before: reconnecting a directory resets `connected_at`,
  // and a session that could not upload under the old connection would have
  // its organization work filed as pre-connect and sent to the community.
  //
  // In "listed" scope the pre-connect tokens go to the community server only if
  // the directory is tracked, and only from when it was; otherwise `from` is
  // null and they are sent nowhere.
  const splitAt = binding ? validInstant(binding.connected_at) : null;
  if (binding && pinnedRouteId === DEFAULT_ROUTE_ID && splitAt) {
    return { kind: 'handoff', from: community, to: bindingRoute(binding), splitAt };
  }

  // A session pinned to an organization keeps going there wherever the user
  // works next, and one whose binding is gone is blocked rather than sent
  // somewhere else.
  if (pinnedRouteId && pinnedRouteId !== DEFAULT_ROUTE_ID) return routeForId(config, pinnedRouteId);

  if (binding && !pinnedRouteId) return bindingRoute(binding);

  // Everything else is the community server's — decided afresh on every
  // upload, pinned or not, so that untracking a directory in "listed" scope
  // stops its sessions at once. Connecting a directory to an organization never
  // changes where unconnected work goes.
  return community ?? SKIP_NOT_TRACKED;
}
