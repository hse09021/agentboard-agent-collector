/**
 * agentboard sweep scan cache (hook runtime)
 *
 * The cross-agent sweep re-visits the same transcript files on every run. This
 * records what each file looked like last time so unchanged files are skipped
 * with a single stat() instead of being re-read and re-parsed — a Claude
 * transcript is routinely tens of megabytes, and parseSingleFile reads the
 * whole thing into memory.
 *
 * Privacy: the cache key is a truncated SHA-256 of the normalized path and
 * nothing else — no path, no basename, no project or repo directory name is
 * ever written. That is not incidental. A transcript path such as
 * ~/.claude/projects/c--Users-alice-work-acme-billing/<uuid>.jsonl carries the
 * repo name in plain text, and `path`/`file_path`/`repo` are on this project's
 * own forbidden-key list. The agent HOME roots are a different matter and are
 * stored in the clear by lib/agent-homes.mjs — a tool config directory says
 * nothing about what the user is working on.
 *
 * Session ids are stored because hook-sent.json already keys on them, so they
 * add no new class of data — and holding one lets a cache-hit file still take
 * part in the sweep's duplicate detection without being parsed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { normalizePath } from './path-normalize.mjs';

export const SWEEP_CACHE_PATH = join(CONFIG_DIR, 'sweep-cache.json');

/** Entries beyond this are dropped oldest-first. Bounds the file on a machine
 *  with years of transcripts. */
export const SCAN_CACHE_MAX_ENTRIES = 5000;

/** An entry not seen for this long is dropped — the file is gone or archived. */
export const SCAN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @typedef {object} ScanEntry
 * @property {number} mtimeMs
 * @property {number} size
 * @property {string} seenAt
 * @property {string} [sid]
 * @property {object} [totals]
 */

function emptyCache() {
  return { version: 1, entries: {} };
}

/**
 * Truncated one-way hash of the normalized path. 16 hex chars (64 bits) — the
 * cache only ever needs to tell one local file from another, and a collision
 * costs a redundant re-parse, not a wrong number.
 *
 * @param {string} absPath
 * @returns {string|null}
 */
export function pathKey(absPath) {
  const normalized = normalizePath(absPath);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function loadScanCache() {
  if (!existsSync(SWEEP_CACHE_PATH)) return emptyCache();
  try {
    const raw = JSON.parse(readFileSync(SWEEP_CACHE_PATH, 'utf-8'));
    if (!raw || raw.version !== 1 || typeof raw.entries !== 'object' || raw.entries === null) {
      return emptyCache();
    }
    return { version: 1, entries: raw.entries };
  } catch {
    return emptyCache();
  }
}

/**
 * Has this file changed since we last looked?
 *
 * Both fields are compared for EXACT equality, never ordering. A "cached mtime
 * is newer than or equal to" test would let a backwards clock jump — or a file
 * restored from backup — make a genuinely changed file look untouched, and the
 * tokens in it would never be collected. Equality can only ever err toward
 * doing redundant work.
 *
 * @param {{entries: Record<string, ScanEntry>}} cache
 * @param {string} absPath
 * @param {{mtimeMs: number, size: number}} stat
 */
export function isUnchanged(cache, absPath, stat) {
  const key = pathKey(absPath);
  if (!key) return false;
  const entry = cache.entries[key];
  if (!entry) return false;
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
}

/**
 * @param {{entries: Record<string, ScanEntry>}} cache mutated in place
 * @param {string} absPath
 * @param {{mtimeMs: number, size: number}} stat
 * @param {{sid?: string, totals?: object, now?: number}} [extra]
 */
export function rememberScan(cache, absPath, stat, extra = {}) {
  const key = pathKey(absPath);
  if (!key) return;
  cache.entries[key] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    seenAt: new Date(extra.now ?? Date.now()).toISOString(),
    ...(extra.sid ? { sid: extra.sid } : {}),
    ...(extra.totals ? { totals: extra.totals } : {}),
  };
}

/** Look up a remembered entry without reparsing. */
export function getCacheEntry(cache, absPath) {
  const key = pathKey(absPath);
  if (!key) return null;
  return cache.entries[key] ?? null;
}

function prune(cache, now) {
  const entries = Object.entries(cache.entries);

  for (const [key, entry] of entries) {
    const seen = Date.parse(entry?.seenAt ?? '');
    if (Number.isFinite(seen) && now - seen > SCAN_CACHE_MAX_AGE_MS) {
      delete cache.entries[key];
    }
  }

  const remaining = Object.entries(cache.entries);
  const overflow = remaining.length - SCAN_CACHE_MAX_ENTRIES;
  if (overflow <= 0) return cache;

  remaining
    .sort((a, b) => String(a[1]?.seenAt).localeCompare(String(b[1]?.seenAt)))
    .slice(0, overflow)
    .forEach(([key]) => delete cache.entries[key]);

  return cache;
}

/** Best-effort: a failed cache write costs a re-parse next run, nothing more. */
export function saveScanCache(cache, opts = {}) {
  try {
    prune(cache, opts.now ?? Date.now());
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(SWEEP_CACHE_PATH, cache);
    return true;
  } catch {
    return false;
  }
}
