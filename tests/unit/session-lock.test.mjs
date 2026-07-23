/**
 * Tests for the per-session upload lock in plugin/hooks/lib/config.mjs
 * (acquireSessionLock / releaseSessionLock).
 *
 * With per-turn hooks (Codex notify, Claude Code Stop) two invocations for the
 * same session can overlap. Both would read the same sent-totals and upload
 * overlapping deltas the server cannot dedup (fresh event_id per upload). The
 * lock makes the overlap harmless: the loser exits without uploading and its
 * tokens ride along in the next invocation's delta.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let config;

// config.mjs resolves its config dir from homedir()/APPDATA at module-load time,
// so we point HOME (and APPDATA on win32) at a temp dir and re-import fresh.
beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-lock-test-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('acquireSessionLock / releaseSessionLock', () => {
  it('grants the lock to the first caller and refuses the second', () => {
    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(true);
    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(false);
  });

  it('can be re-acquired after release', () => {
    config.acquireSessionLock('claude_code', 'sess-1');
    config.releaseSessionLock('claude_code', 'sess-1');
    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(true);
  });

  it('is keyed per source + session id', () => {
    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(true);
    expect(config.acquireSessionLock('claude_code', 'sess-2')).toBe(true);
    expect(config.acquireSessionLock('codex', 'sess-1')).toBe(true);
  });

  it('takes over a stale lock left by a crashed holder', () => {
    config.acquireSessionLock('claude_code', 'sess-1');
    // Age the lock dir past the stale threshold (2 minutes).
    const lockDir = join(config.CONFIG_DIR, 'locks', 'claude_code__sess-1');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockDir, old, old);

    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(true);
    // ...and the takeover holds a fresh lock, not a stale leftover.
    expect(config.acquireSessionLock('claude_code', 'sess-1')).toBe(false);
  });

  it('releasing a lock that is not held is a no-op', () => {
    expect(() =>
      config.releaseSessionLock('claude_code', 'never-acquired')
    ).not.toThrow();
  });

  it('sanitizes path-hostile session ids into a flat lock name', () => {
    // A session id containing separators must not escape the locks dir.
    expect(config.acquireSessionLock('claude_code', '../../evil/../id')).toBe(true);
    expect(config.acquireSessionLock('claude_code', '../../evil/../id')).toBe(false);
  });
});
