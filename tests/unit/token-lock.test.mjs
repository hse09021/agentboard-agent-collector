/**
 * The refresh lock (stage 2).
 *
 * Without it two hooks submit the same refresh token, the server reads the
 * second submission as a replay of an already-used token, treats it as theft
 * and burns the family — logging a perfectly well-behaved user out. So the
 * cases that matter are: only one winner, a crashed holder never wedges
 * refresh forever, and the lock is always released.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let configDir;
let lock;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-token-lock-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.resetModules();
  lock = await import('../../plugin/hooks/lib/token-lock.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

const lockPath = () => join(configDir, '.token.lock');

describe('acquireTokenLock / releaseTokenLock', () => {
  it('grants the lock to the first caller', async () => {
    expect(await lock.acquireTokenLock()).toBe(true);
    expect(existsSync(lockPath())).toBe(true);
  });

  it('refuses a second caller while held, then grants after release', async () => {
    expect(await lock.acquireTokenLock()).toBe(true);
    // Short timeout: the point is that it does NOT get the lock, not how long
    // it is willing to wait.
    expect(await lock.acquireTokenLock(150)).toBe(false);

    lock.releaseTokenLock();
    expect(await lock.acquireTokenLock(150)).toBe(true);
  });

  // 훅은 자주 강제 종료된다. 남은 락을 영영 존중하면 이후 모든 갱신이 막힌다.
  it('takes over a stale lock', async () => {
    writeFileSync(lockPath(), '99999');
    const old = (Date.now() - lock.LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lockPath(), old, old);

    expect(await lock.acquireTokenLock(150)).toBe(true);
  });

  it('respects a fresh lock held by another pid', async () => {
    writeFileSync(lockPath(), '99999');

    expect(await lock.acquireTokenLock(150)).toBe(false);
  });

  it('release is safe when the lock is already gone', () => {
    expect(() => lock.releaseTokenLock()).not.toThrow();
  });
});

describe('withTokenLock', () => {
  it('releases the lock after the callback resolves', async () => {
    const result = await withResult(() => 'done');

    expect(result).toBe('done');
    expect(existsSync(lockPath())).toBe(false);
  });

  // finally 로 풀지 않으면, 갱신 중 한 번 던진 예외가 이후 모든 갱신을
  // stale timeout 만큼 지연시킨다.
  it('releases the lock when the callback throws', async () => {
    await expect(
      lock.withTokenLock(
        async () => {
          throw new Error('boom');
        },
        () => 'busy',
      ),
    ).rejects.toThrow('boom');

    expect(existsSync(lockPath())).toBe(false);
  });

  it('runs onBusy instead when the lock is held', async () => {
    await lock.acquireTokenLock();

    const result = await lock.withTokenLock(
      async () => 'refreshed',
      () => 'busy',
      { timeoutMs: 150 },
    );

    expect(result).toBe('busy');
  });

  async function withResult(fn) {
    return lock.withTokenLock(async () => fn(), () => 'busy');
  }
});

describe('concurrent acquisition', () => {
  // 락의 존재 이유 그 자체: 동시에 N 개가 달려들어도 갱신하는 건 하나뿐이어야 한다.
  it('lets exactly one of many concurrent callers in at a time', async () => {
    let inside = 0;
    let maxInside = 0;
    let winners = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        lock.withTokenLock(
          async () => {
            winners++;
            inside++;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 20));
            inside--;
          },
          () => {},
        ),
      ),
    );

    expect(maxInside).toBe(1);
    expect(winners).toBeGreaterThan(0);
  });
});
