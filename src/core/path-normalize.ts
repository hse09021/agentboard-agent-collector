/**
 * Path normalization for directory→server routing.
 *
 * Getting this wrong is a privacy bug, not a cosmetic one: a false match sends
 * one project's telemetry to another organization's server, and a false miss
 * sends company work to the developer's personal account. Both directions are
 * bad, so every rule below picks the option that fails toward "no match" only
 * when the alternative would be a cross-boundary leak.
 *
 * Keep in sync with plugin/hooks/lib/path-normalize.mjs.
 */

import * as fs from "fs";
import * as path from "path";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

/**
 * Canonical form used for comparison. Never store this — it is lossy (case is
 * folded on Windows/macOS) and resolves symlinks, so it is only meaningful for
 * matching.
 */
export function normalizePath(
  input: string | undefined | null,
  opts: { platform?: NodeJS.Platform } = {}
): string | null {
  if (!input || typeof input !== "string") return null;

  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const mac = platform === "darwin";

  let resolved: string;
  try {
    resolved = path.resolve(input);
  } catch {
    return null;
  }

  // Resolve symlinks so that /tmp and /private/tmp (macOS), or a junction and
  // its target (Windows), compare equal. A deleted directory is normal — a
  // binding outlives the directory it points at — so fall back to the literal.
  try {
    resolved = win ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    /* keep the resolved-but-unlinked form */
  }

  let out = resolved.replace(/\\/g, "/");

  // Trailing separators must go, but "/" and "C:/" are themselves valid roots.
  out = out.replace(/(.)\/+$/, "$1");

  if (win) {
    // c:/x and C:/x are the same directory.
    out = out.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  }

  // NTFS and APFS are case-insensitive by default. Folding case risks a false
  // match only on a case-sensitive volume (rare); NOT folding risks a miss on
  // every ordinary machine, and a miss routes company work to a personal
  // server. Fold.
  if (win || mac) out = out.toLowerCase();

  return out;
}

/**
 * True when `child` is `parent` or lives underneath it.
 *
 * The `+ "/"` is the whole point: a bare startsWith makes "/work/api" swallow
 * "/work/api-secret", which is a different project and possibly a different
 * organization's server.
 */
export function isPathPrefix(parent: string | null, child: string | null): boolean {
  if (!parent || !child) return false;
  if (child === parent) return true;
  const withSep = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(withSep);
}

/** Exposed for diagnostics; matching itself always goes through normalizePath. */
export const platformIsCaseInsensitive = isWindows || isMac;
