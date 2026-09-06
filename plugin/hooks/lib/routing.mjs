/**
 * Directory to server routing (hook runtime).
 *
 * Mirror of src/core/routing.ts — keep the two in sync. Pure: the caller passes
 * the config and the session's pinned route, so the hook and the CLI cannot
 * disagree about where a session's data goes.
 */

import { normalizePath, isPathPrefix } from './path-normalize.mjs';

export const DEFAULT_ROUTE_ID = 'default';

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

export function routeForId(config, routeId) {
  if (routeId === DEFAULT_ROUTE_ID) {
    return {
      kind: 'send',
      routeId: DEFAULT_ROUTE_ID,
      server: config.default_server,
      credentialRef: null,
    };
  }

  const binding = (config.bindings ?? []).find((b) => b.credential_ref === routeId);
  if (!binding) return { kind: 'blocked', reason: 'route_missing' };

  return {
    kind: 'send',
    routeId,
    server: binding.server,
    credentialRef: binding.credential_ref,
    binding,
  };
}

export function resolveRoute({ config, cwd, pinnedRouteId }) {
  // A session never changes server mid-flight. The ledger holds one cumulative
  // total per session, so re-deriving the route from cwd after a directory is
  // connected would hand the organization's server the whole cumulative figure,
  // including the personal work that came before the connection.
  if (pinnedRouteId) return routeForId(config, pinnedRouteId);

  const binding = matchBinding(config.bindings, cwd);
  if (binding) {
    return {
      kind: 'send',
      routeId: binding.credential_ref,
      server: binding.server,
      credentialRef: binding.credential_ref,
      binding,
    };
  }

  // Connecting a directory to an organization never changes where
  // unconnected work goes.
  return {
    kind: 'send',
    routeId: DEFAULT_ROUTE_ID,
    server: config.default_server,
    credentialRef: null,
  };
}
