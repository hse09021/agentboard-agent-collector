/**
 * agentboard atomic JSON writer (CLI)
 *
 * Mirror of plugin/hooks/lib/atomic-write.mjs — see that file for why this
 * exists. Keep the two in sync.
 */

import * as fs from "fs";

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts: { mode?: number } = {}
): void {
  const mode = opts.mode ?? 0o600;
  // Sibling temp file: rename() is only atomic within a filesystem, and on
  // Windows it fails outright across volumes.
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf-8",
      mode,
    });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
