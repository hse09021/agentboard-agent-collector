/**
 * Cross-process lock around token refresh (hook runtime).
 *
 * Mirror of src/platform/token-lock.ts — see that file for why this exists.
 * The same lock guards each connected project's credential, at its own path.
 * The hook cannot import the built TypeScript, so the logic lives twice.
 * Keep the two in sync; docs/token-refresh.md is the contract.
 */

import { closeSync, openSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export const LOCK_STALE_MS = 30_000;

// Deliberately short. A hook that loses the race does not need the lock: it
// re-reads the token file, and the winner has by then written a fresh bundle.
// Blocking longer would only add latency to every session end for no gain.
const ACQUIRE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 50;

/** The default route's lock, guarding `.token`. */
export const TOKEN_LOCK_PATH = join(CONFIG_DIR, '.token.lock');

function tryCreate(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
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

function ageMs(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the lock at `lockPath`, taking over a stale one.
 *
 * The caller always names the lock: `.token.lock` for the default route,
 * credentials/<ref>.lock for each connected project. They guard different
 * refresh families on different servers, so they never wait on each other.
 *
 * A caller that fails to acquire must NOT refresh anyway — it re-reads the
 * token file, because the holder is almost certainly writing a fresh bundle.
 *
 * @param {string} lockPath
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function acquireFileLock(lockPath, timeoutMs = ACQUIRE_TIMEOUT_MS) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryCreate(lockPath)) return true;

    const age = ageMs(lockPath);
    if (age !== null && age > LOCK_STALE_MS) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* raced with the holder's release or another stealer */
      }
      continue;
    }

    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** @param {string} lockPath */
export function releaseFileLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already released or stolen */
  }
}

/**
 * Runs `fn` under the lock at `lockPath`, releasing in `finally`. `onBusy`
 * runs instead when the lock could not be taken.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {() => Promise<T>|T} onBusy
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, fn, onBusy, opts = {}) {
  if (!(await acquireFileLock(lockPath, opts.timeoutMs))) return onBusy();
  try {
    return await fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

/** @param {number} [timeoutMs] */
export function acquireTokenLock(timeoutMs) {
  return acquireFileLock(TOKEN_LOCK_PATH, timeoutMs);
}

export function releaseTokenLock() {
  releaseFileLock(TOKEN_LOCK_PATH);
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {() => Promise<T>|T} onBusy
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export function withTokenLock(fn, onBusy, opts = {}) {
  return withFileLock(TOKEN_LOCK_PATH, fn, onBusy, opts);
}
