/**
 * Directory to server routing.
 *
 * A session's telemetry goes to the server of the directory it ran in.
 * Connected directories go to their organization's server; everything else
 * goes to the community server. That is what keeps a developer's personal
 * projects off their employer's server structurally, rather than by policy.
 *
 * This module is pure: callers pass the config and the pinned route, so both
 * the CLI and the hook runtime get identical answers and every branch is
 * testable without touching disk.
 *
 * Keep in sync with plugin/hooks/lib/routing.mjs.
 */

import type { Binding, CollectorConfigV2, ServerRef } from "./config-schema";
import { isPathPrefix, normalizePath } from "./path-normalize";

/** Identifies a destination in the ledger and in server-state. */
export const DEFAULT_ROUTE_ID = "default";

export interface SendRoute {
  kind: "send";
  routeId: string;
  server: ServerRef;
  /** null means "use the default server's token" (.token). */
  credentialRef: string | null;
  binding?: Binding;
}

export type Route =
  | SendRoute
  /**
   * Tokens from before `splitAt` go to `from`, the rest to `to`. Returned for
   * a session that has only ever gone to the community server and is now
   * working in a directory connected at `splitAt`.
   */
  | { kind: "handoff"; from: SendRoute; to: SendRoute; splitAt: string }
  | { kind: "blocked"; reason: "route_missing" };

export interface ResolveRouteInput {
  config: CollectorConfigV2;
  /** From the hook payload only — never process.cwd(). */
  cwd?: string | null;
  /**
   * Route this session was pinned to by its last successful upload. See the
   * notes in resolveRoute for when it outranks cwd.
   */
  pinnedRouteId?: string | null;
}

/**
 * Longest-prefix match over binding directories.
 *
 * Both the literal and the realpath form are compared, because a developer may
 * connect `~/work/api` (a symlink) and later run in `/Volumes/ext/api`.
 */
export function matchBinding(
  bindings: Binding[],
  cwd: string | null | undefined
): Binding | null {
  const target = normalizePath(cwd);
  if (!target) return null;

  let best: { binding: Binding; length: number } | null = null;

  for (const binding of bindings) {
    for (const candidate of [binding.abs_dir, binding.real_dir]) {
      const dir = normalizePath(candidate);
      if (!isPathPrefix(dir, target)) continue;
      const length = dir!.length;
      if (!best || length > best.length) best = { binding, length };
    }
  }

  return best?.binding ?? null;
}

function defaultRoute(config: CollectorConfigV2): SendRoute {
  return {
    kind: "send",
    routeId: DEFAULT_ROUTE_ID,
    server: config.default_server,
    credentialRef: null,
  };
}

function bindingRoute(binding: Binding): SendRoute {
  return {
    kind: "send",
    routeId: binding.credential_ref,
    server: binding.server,
    credentialRef: binding.credential_ref,
    binding,
  };
}

export function routeForId(
  config: CollectorConfigV2,
  routeId: string
): Route {
  if (routeId === DEFAULT_ROUTE_ID) return defaultRoute(config);

  const binding = config.bindings.find((b) => b.credential_ref === routeId);
  if (!binding) return { kind: "blocked", reason: "route_missing" };

  return bindingRoute(binding);
}

function validInstant(iso: unknown): string | null {
  return typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function resolveRoute(input: ResolveRouteInput): Route {
  const { config, cwd, pinnedRouteId } = input;
  const binding = matchBinding(config.bindings, cwd);

  // 1. A session that has only ever gone to the community server, now working
  // in a connected directory, is handed off at the moment of connection.
  //
  // The delta ledger holds one cumulative total per session, so the route
  // alone cannot say which of its tokens came before the connection. Moving
  // the whole session to the organization would give it the personal work
  // done before `connect`; keeping the whole session on the community server
  // would ship the organization's work there for as long as the session lives.
  // Splitting at `connected_at` honours both: earlier tokens stay with the
  // community server, later ones go to the organization's.
  //
  // Only a session pinned to the community server is handed off. An unpinned
  // one goes by cwd as before: reconnecting a directory resets `connected_at`,
  // and a session that could not upload under the old connection would have
  // its organization work filed as pre-connect and sent to the community.
  const splitAt = binding ? validInstant(binding.connected_at) : null;
  if (binding && pinnedRouteId === DEFAULT_ROUTE_ID && splitAt) {
    return { kind: "handoff", from: defaultRoute(config), to: bindingRoute(binding), splitAt };
  }

  // 2. Otherwise a pinned session stays where it is. A session pinned to an
  // organization keeps going there wherever the user works next, and one whose
  // binding is gone is blocked rather than sent somewhere else.
  if (pinnedRouteId) return routeForId(config, pinnedRouteId);

  // 3. Connected directory wins.
  if (binding) return bindingRoute(binding);

  // 4. Everything else is the community server. Connecting a directory to an
  // organization never changes where unconnected work goes.
  return defaultRoute(config);
}
