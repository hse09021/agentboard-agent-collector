/**
 * Cross-process lock around token refresh (hook runtime).
 *
 * Mirror of src/platform/token-lock.ts — see that file for why this exists.
 * The hook cannot import the built TypeScript, so the logic lives twice.
 * Keep the two in sync; docs/token-refresh.md is the contract.
 */

import { closeSync, openSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export const LOCK_STALE_MS = 30_000;

// Deliberately short. A hook that loses the race does not need the lock: it
// re-reads the token file, and the winner has by then written a fresh bundle.
// Blocking longer would only add latency to every session end for no gain.
const ACQUIRE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 50;

export const TOKEN_LOCK_PATH = join(CONFIG_DIR, '.token.lock');

function tryCreate() {
  try {
    const fd = openSync(TOKEN_LOCK_PATH, 'wx', 0o600);
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function ageMs() {
  try {
    return Date.now() - statSync(TOKEN_LOCK_PATH).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the lock, taking over a stale one.
 *
 * A caller that fails to acquire must NOT refresh anyway — it re-reads the
 * token file, because the holder is almost certainly writing a fresh bundle.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function acquireTokenLock(timeoutMs = ACQUIRE_TIMEOUT_MS) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryCreate()) return true;

    const age = ageMs();
    if (age !== null && age > LOCK_STALE_MS) {
      try {
        unlinkSync(TOKEN_LOCK_PATH);
      } catch {
        /* raced with the holder's release or another stealer */
      }
      continue;
    }

    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

export function releaseTokenLock() {
  try {
    unlinkSync(TOKEN_LOCK_PATH);
  } catch {
    /* already released or stolen */
  }
}

/**
 * Runs `fn` under the lock, releasing in `finally`. `onBusy` runs instead when
 * the lock could not be taken.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {() => Promise<T>|T} onBusy
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withTokenLock(fn, onBusy, opts = {}) {
  if (!(await acquireTokenLock(opts.timeoutMs))) return onBusy();
  try {
    return await fn();
  } finally {
    releaseTokenLock();
  }
}
