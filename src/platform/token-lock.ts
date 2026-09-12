/**
 * Cross-process lock around token refresh.
 *
 * Hooks fire on every session end, so two of them refreshing at once is
 * routine (Claude Code and Codex together, several terminals). Rotation makes
 * that dangerous: both would submit the SAME refresh token, the server would
 * see the second submission as a replay of an already-used token, treat it as
 * theft, and burn the whole family — logging the user out. The security feature
 * would be the thing that breaks them.
 *
 * This is the first of two defences; the second is the server's grace window
 * for a re-submission within 30s of `used_at`. See docs/token-refresh.md.
 *
 * Mirror of plugin/hooks/lib/token-lock.mjs — keep the two in sync.
 */

import * as fs from "fs";
import { getConfigDir, ensureConfigDir } from "../core/config";
import * as path from "path";

/** A holder older than this is assumed dead and taken over. */
export const LOCK_STALE_MS = 30_000;

const ACQUIRE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

export function getTokenLockPath(): string {
  return path.join(getConfigDir(), ".token.lock");
}

/**
 * `wx` is the atomic primitive: create-if-absent, EEXIST otherwise. Unlike
 * mkdir the file carries our pid, which makes a leaked lock diagnosable.
 */
function tryCreate(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function ageMs(lockPath: string): number | null {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null; // vanished between checks — the next create attempt decides
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the lock, taking over a stale one.
 *
 * Returns false on timeout. A caller that fails to acquire must NOT refresh
 * anyway — it should re-read the token file, because whoever holds the lock is
 * almost certainly writing a fresh bundle right now.
 */
export async function acquireTokenLock(
  timeoutMs = ACQUIRE_TIMEOUT_MS
): Promise<boolean> {
  try {
    ensureConfigDir();
  } catch {
    return false;
  }

  const lockPath = getTokenLockPath();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryCreate(lockPath)) return true;

    const age = ageMs(lockPath);
    if (age !== null && age > LOCK_STALE_MS) {
      // Hooks get SIGKILLed often enough that a leaked lock is a real
      // scenario, and one would otherwise delay every later refresh forever.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced with the holder's release or another stealer */
      }
      continue;
    }

    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

export function releaseTokenLock(): void {
  try {
    fs.unlinkSync(getTokenLockPath());
  } catch {
    /* already released or stolen */
  }
}

/**
 * Runs `fn` under the lock, releasing in `finally`.
 *
 * `onBusy` runs instead when the lock could not be taken — that is the
 * "re-read what the winner wrote" path, not an error.
 */
export async function withTokenLock<T>(
  fn: () => Promise<T>,
  onBusy: () => Promise<T> | T,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  if (!(await acquireTokenLock(opts.timeoutMs))) return onBusy();
  try {
    return await fn();
  } finally {
    releaseTokenLock();
  }
}
