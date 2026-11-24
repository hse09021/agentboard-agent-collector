/**
 * Collection scope for the default (community) server (#23).
 *
 * In "all" scope — the default — every directory that is not connected to an
 * organization sends its usage to the default server, as it always has. In
 * "listed" scope only the directories in `tracked_dirs` (and below them) do,
 * and only what was used after each was added; everything else is sent
 * nowhere. Connected directories are unaffected either way.
 *
 * Pure functions over the config: the CLI saves what they return. The paths
 * stay in config.json and are never uploaded.
 */

import * as fs from "fs";
import * as path from "path";
import {
  stripTrailingSlash,
  type Binding,
  type CollectorConfigV2,
  type DefaultScope,
  type ServerRef,
  type TrackedDir,
} from "./config-schema";
import { normalizePath } from "./path-normalize";
import { matchBinding } from "./routing";

function resolveDir(dir: string): { absDir: string; realDir: string } {
  const absDir = path.resolve(dir);
  let realDir = absDir;
  try {
    realDir = fs.realpathSync(absDir);
  } catch {
    /* the directory may not exist (yet); keep the literal */
  }
  return { absDir, realDir };
}

function sameDir(entry: TrackedDir, absDir: string, realDir: string): boolean {
  const candidates = new Set([normalizePath(absDir), normalizePath(realDir)]);
  return candidates.has(normalizePath(entry.abs_dir)) || candidates.has(normalizePath(entry.real_dir));
}

/** The entry for exactly this directory, if it is tracked. */
export function findTrackedDir(config: CollectorConfigV2, dir: string): TrackedDir | undefined {
  const { absDir, realDir } = resolveDir(dir);
  return config.tracked_dirs.find((entry) => sameDir(entry, absDir, realDir));
}

/** The tracked entry this directory falls under, itself or a parent. */
export function trackedDirCovering(config: CollectorConfigV2, dir: string): TrackedDir | null {
  const { absDir, realDir } = resolveDir(dir);
  return matchBinding(config.tracked_dirs, absDir) ?? matchBinding(config.tracked_dirs, realDir);
}

/**
 * The connected project this directory falls under, if any. Its usage goes to
 * that organization whatever the scope says.
 */
export function bindingCovering(config: CollectorConfigV2, dir: string): Binding | null {
  const { absDir, realDir } = resolveDir(dir);
  return matchBinding(config.bindings, absDir) ?? matchBinding(config.bindings, realDir);
}

/**
 * Adds a directory. Tracking one that is already tracked keeps its original
 * `added_at`: it has been collected since then, and resetting the instant would
 * withhold usage that was meant to be sent.
 */
export function addTrackedDir(
  config: CollectorConfigV2,
  dir: string,
  now: Date = new Date()
): { config: CollectorConfigV2; tracked: TrackedDir; alreadyTracked: boolean } {
  const existing = findTrackedDir(config, dir);
  if (existing) return { config, tracked: existing, alreadyTracked: true };

  const { absDir, realDir } = resolveDir(dir);
  const tracked: TrackedDir = { abs_dir: absDir, real_dir: realDir, added_at: now.toISOString() };
  return {
    config: { ...config, tracked_dirs: [...config.tracked_dirs, tracked] },
    tracked,
    alreadyTracked: false,
  };
}

/** Removes exactly this directory. A parent that covers it is left alone. */
export function removeTrackedDir(
  config: CollectorConfigV2,
  dir: string
): { config: CollectorConfigV2; removed?: TrackedDir } {
  const removed = findTrackedDir(config, dir);
  if (!removed) return { config };
  return { config: { ...config, tracked_dirs: config.tracked_dirs.filter((d) => d !== removed) }, removed };
}

export function setDefaultScope(config: CollectorConfigV2, scope: DefaultScope): CollectorConfigV2 {
  return { ...config, default_scope: scope };
}

/**
 * A server as messages name it: "label (host)", or the host alone when the
 * label adds nothing (#27).
 *
 * An organization's server labels itself, typically with something like
 * "Organization", which says nothing about where usage actually goes. The host
 * is what tells the community server and an organization's apart.
 */
export function serverDisplayName(server: ServerRef): string {
  let host = server.app_base_url;
  let hostname = server.app_base_url;
  try {
    const url = new URL(server.app_base_url);
    host = url.host;
    hostname = url.hostname;
  } catch {
    /* not a URL; show it as it is */
  }
  const label = server.label?.trim();
  if (!label || label === host || label === hostname) return host;
  return `${label} (${host})`;
}

/** The default server's name for messages. */
export function defaultServerName(config: CollectorConfigV2): string {
  return serverDisplayName(config.default_server);
}

/**
 * Where unconnected directories' usage goes, as `status` and `doctor` both
 * describe it, so the two cannot disagree (#27).
 */
export interface CollectionScopeSummary {
  scope: DefaultScope;
  /** The default server, as messages name it. */
  server: string;
  /** What happens to usage from a directory that is not connected. */
  headline: string;
  /**
   * Set when the default server is also a connected project's server and
   * something is sent there: the user logged in to their organization, so
   * unconnected usage reaches it too.
   */
  note?: string;
  /** Listed whatever the scope: in "all" they are kept but have no effect. */
  tracked: TrackedDir[];
  trackedHeading: string;
}

/** Uploads go to api_base_url, so that is what decides "the same server". */
function sameServer(a: ServerRef, b: ServerRef): boolean {
  return stripTrailingSlash(a.api_base_url) === stripTrailingSlash(b.api_base_url);
}

export function describeCollectionScope(config: CollectorConfigV2): CollectionScopeSummary {
  const server = defaultServerName(config);
  const listed = config.default_scope === "listed";

  const sendsNothing = listed && config.tracked_dirs.length === 0;

  let headline: string;
  if (!listed) {
    headline = `every directory not connected to an organization sends usage to ${server}`;
  } else if (sendsNothing) {
    headline = `no directory is tracked, so nothing goes to ${server}; run \`agentboard track <dir>\` to add one`;
  } else {
    headline = `only tracked directories send usage to ${server}; other unconnected directories send nothing`;
  }

  const sharesOrganization =
    !sendsNothing && config.bindings.some((b) => sameServer(b.server, config.default_server));
  const reaching = listed ? "tracked directories" : "unconnected directories";

  return {
    scope: config.default_scope,
    server,
    headline,
    note: sharesOrganization
      ? `${server} is also your connected projects' server: usage from ${reaching} reaches that organization too, outside any project`
      : undefined,
    tracked: config.tracked_dirs,
    trackedHeading: listed ? "Tracked directories" : "Tracked directories (used only in listed scope)",
  };
}
