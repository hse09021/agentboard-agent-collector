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
import type { Binding, CollectorConfigV2, DefaultScope, TrackedDir } from "./config-schema";
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

/** The default server's name for messages: its label, else its host. */
export function defaultServerName(config: CollectorConfigV2): string {
  if (config.default_server.label) return config.default_server.label;
  try {
    return new URL(config.default_server.app_base_url).host;
  } catch {
    return config.default_server.app_base_url;
  }
}
