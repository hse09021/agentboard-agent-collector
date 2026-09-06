/**
 * Path normalization for directory to server routing (hook runtime).
 *
 * Mirror of src/core/path-normalize.ts — keep the two in sync. See that file
 * for why each rule is the way it is; the short version is that a wrong answer
 * here routes one project's telemetry to another organization's server.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function normalizePath(input, opts = {}) {
  if (!input || typeof input !== 'string') return null;

  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  let resolved;
  try {
    resolved = resolve(input);
  } catch {
    return null;
  }

  // Resolve symlinks so /tmp and /private/tmp compare equal. A deleted
  // directory is normal (a binding outlives the directory), so fall back to
  // the literal form.
  try {
    resolved = win ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch {
    /* keep the unlinked form */
  }

  let out = resolved.replace(/\\/g, '/');
  out = out.replace(/(.)[/]+$/, '$1');
  if (win) out = out.replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ':');
  if (win || mac) out = out.toLowerCase();

  return out;
}

/**
 * The trailing separator is the whole point: a bare startsWith makes
 * "/work/api" swallow "/work/api-secret".
 */
export function isPathPrefix(parent, child) {
  if (!parent || !child) return false;
  if (child === parent) return true;
  const withSep = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(withSep);
}
