/**
 * Directory to server routing.
 *
 * A session's telemetry goes to exactly one server, decided by the directory it
 * ran in. Connected directories go to their organization's server; everything
 * else goes to the community server. That is what keeps a developer's personal
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

export type Route =
  | {
      kind: "send";
      routeId: string;
      server: ServerRef;
      /** null means "use the default server's token" (.token). */
      credentialRef: string | null;
      binding?: Binding;
    }
  | { kind: "blocked"; reason: "route_missing" };

export interface ResolveRouteInput {
  config: CollectorConfigV2;
  /** From the hook payload only — never process.cwd(). */
  cwd?: string | null;
  /**
   * Route this session was pinned to by its first successful upload.
   * Outranks cwd: see the note below.
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

export function routeForId(
  config: CollectorConfigV2,
  routeId: string
): Route {
  if (routeId === DEFAULT_ROUTE_ID) {
    return {
      kind: "send",
      routeId: DEFAULT_ROUTE_ID,
      server: config.default_server,
      credentialRef: null,
    };
  }

  const binding = config.bindings.find((b) => b.credential_ref === routeId);
  if (!binding) return { kind: "blocked", reason: "route_missing" };

  return {
    kind: "send",
    routeId,
    server: binding.server,
    credentialRef: binding.credential_ref,
    binding,
  };
}

export function resolveRoute(input: ResolveRouteInput): Route {
  const { config, cwd, pinnedRouteId } = input;

  // 1. A session never changes server mid-flight.
  //
  // The delta ledger holds one cumulative total per session. If a directory is
  // connected partway through a session and we re-resolved by cwd, the newly
  // chosen server would receive the whole cumulative figure — including the
  // stretch of personal work that happened before the connection. Pinning is
  // what prevents that retroactive leak, so it outranks cwd.
  if (pinnedRouteId) return routeForId(config, pinnedRouteId);

  // 2. Connected directory wins.
  const binding = matchBinding(config.bindings, cwd);
  if (binding) {
    return {
      kind: "send",
      routeId: binding.credential_ref,
      server: binding.server,
      credentialRef: binding.credential_ref,
      binding,
    };
  }

  // 3. Everything else is the community server. Connecting a directory to an
  // organization never changes where unconnected work goes.
  return {
    kind: "send",
    routeId: DEFAULT_ROUTE_ID,
    server: config.default_server,
    credentialRef: null,
  };
}
