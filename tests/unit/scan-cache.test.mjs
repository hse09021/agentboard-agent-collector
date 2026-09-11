/**
 * Tests for plugin/hooks/lib/scan-cache.mjs.
 *
 * The cache exists so the sweep can skip unchanged transcripts with one stat()
 * instead of reading and parsing a multi-megabyte file. Its two load-bearing
 * properties are that the key leaks no path (see tests/privacy) and that the
 * change check can never produce a false "unchanged".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let mod;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-scancache-test-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.resetModules();
  const config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  mod = await import('../../plugin/hooks/lib/scan-cache.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('pathKey', () => {
  it('is 16 hex characters and stable across calls', () => {
    const key = mod.pathKey('/work/proj/session.jsonl');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(mod.pathKey('/work/proj/session.jsonl')).toBe(key);
  });

  it('distinguishes sibling paths', () => {
    expect(mod.pathKey('/work/a.jsonl')).not.toBe(mod.pathKey('/work/b.jsonl'));
  });

  it('returns null for junk input', () => {
    expect(mod.pathKey('')).toBeNull();
    expect(mod.pathKey(null)).toBeNull();
  });
});

describe('isUnchanged', () => {
  const file = '/work/proj/session.jsonl';

  it('is false for a file never seen', () => {
    expect(mod.isUnchanged(mod.loadScanCache(), file, { mtimeMs: 1, size: 2 })).toBe(false);
  });

  it('is true only when BOTH mtime and size match exactly', () => {
    const cache = mod.loadScanCache();
    mod.rememberScan(cache, file, { mtimeMs: 1000, size: 500 });

    expect(mod.isUnchanged(cache, file, { mtimeMs: 1000, size: 500 })).toBe(true);
    expect(mod.isUnchanged(cache, file, { mtimeMs: 1000, size: 501 })).toBe(false);
    expect(mod.isUnchanged(cache, file, { mtimeMs: 1001, size: 500 })).toBe(false);
  });

  it('never reports unchanged for a file whose mtime moved backwards', () => {
    // An ordering comparison ("cached >= current") would call this unchanged
    // and the tokens in it would never be collected. Equality cannot.
    const cache = mod.loadScanCache();
    mod.rememberScan(cache, file, { mtimeMs: 5000, size: 500 });
    expect(mod.isUnchanged(cache, file, { mtimeMs: 1000, size: 900 })).toBe(false);
  });
});

describe('pruning', () => {
  it('drops entries older than SCAN_CACHE_MAX_AGE_MS on save', () => {
    const now = Date.now();
    const cache = mod.loadScanCache();
    mod.rememberScan(cache, '/work/old.jsonl', { mtimeMs: 1, size: 1 }, {
      now: now - mod.SCAN_CACHE_MAX_AGE_MS - 60_000,
    });
    mod.rememberScan(cache, '/work/new.jsonl', { mtimeMs: 1, size: 1 }, { now });

    mod.saveScanCache(cache, { now });

    const reloaded = mod.loadScanCache();
    expect(reloaded.entries[mod.pathKey('/work/old.jsonl')]).toBeUndefined();
    expect(reloaded.entries[mod.pathKey('/work/new.jsonl')]).toBeDefined();
  });

  it('caps the entry count, dropping the oldest first', () => {
    const now = Date.now();
    const cache = mod.loadScanCache();
    for (let i = 0; i < mod.SCAN_CACHE_MAX_ENTRIES + 10; i++) {
      mod.rememberScan(cache, `/work/f${i}.jsonl`, { mtimeMs: i, size: i }, { now: now - (10_000 - i) });
    }
    mod.saveScanCache(cache, { now });

    const reloaded = mod.loadScanCache();
    expect(Object.keys(reloaded.entries).length).toBeLessThanOrEqual(mod.SCAN_CACHE_MAX_ENTRIES);
    expect(reloaded.entries[mod.pathKey('/work/f0.jsonl')]).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('persists session id alongside the fingerprint', () => {
    const cache = mod.loadScanCache();
    mod.rememberScan(cache, '/work/s.jsonl', { mtimeMs: 7, size: 8 }, { sid: 'sess-1' });
    mod.saveScanCache(cache);

    expect(mod.getCacheEntry(mod.loadScanCache(), '/work/s.jsonl')).toMatchObject({
      mtimeMs: 7,
      size: 8,
      sid: 'sess-1',
    });
  });

  it('survives a corrupt cache file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(mod.SWEEP_CACHE_PATH, '{ not json');
    expect(mod.loadScanCache()).toEqual({ version: 1, entries: {} });
  });
});
