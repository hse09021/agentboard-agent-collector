/**
 * agentboard atomic JSON writer (hook runtime)
 *
 * Every state file under the config dir is written by hooks that can run
 * concurrently: Claude Code fires Stop per turn while Codex fires notify, and
 * v0.7.0 adds per-route state on top. A plain writeFileSync truncates the file
 * before the new bytes land, so a reader (or a crash) in that window sees a
 * half-written file and the whole ledger is lost.
 *
 * Write to a sibling temp file, then rename. rename() is atomic within a
 * filesystem, so a reader sees either the old file or the new one.
 *
 * Keep in sync with src/core/atomic-write.ts.
 */

import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

/**
 * @param {string} filePath
 * @param {unknown} value      serialized with JSON.stringify(value, null, 2)
 * @param {{mode?: number}} [opts]
 */
export function writeJsonAtomic(filePath, value, opts = {}) {
  const mode = opts.mode ?? 0o600;
  // Same directory as the target: rename() across filesystems is not atomic
  // (and fails outright on Windows), so the temp file must be a sibling.
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', { mode });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Never leave the temp file behind — a crashed worker would otherwise
    // litter the config dir with .tmp files that nothing ever cleans up.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
