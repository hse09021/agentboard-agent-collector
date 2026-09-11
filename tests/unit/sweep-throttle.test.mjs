/**
 * Throttle tests for plugin/hooks/lib/sweep.mjs.
 *
 * The sweep is triggered by hooks that fire every turn, so without a gate it
 * would rescan on every keystroke-sized interaction. `force` (session end)
 * bypasses the interval — but never the process lock, which is what actually
 * prevents two sweeps overlapping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let sweep;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-sweep-throttle-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('AGENTBOARD_SWEEP_INTERVAL_MS', '');
  vi.resetModules();
  const config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  sweep = await import('../../plugin/hooks/lib/sweep.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('shouldSweep', () => {
  it('allows the first sweep', () => {
    expect(sweep.shouldSweep()).toBe(true);
  });

  it('refuses again inside the minimum interval', () => {
    const now = Date.now();
    sweep.markSweepStarted({ now });
    expect(sweep.shouldSweep({ now: now + 60_000 })).toBe(false);
  });

  it('allows again once the interval has passed', () => {
    const now = Date.now();
    sweep.markSweepStarted({ now });
    expect(sweep.shouldSweep({ now: now + sweep.SWEEP_MIN_INTERVAL_MS + 1 })).toBe(true);
  });

  it('force bypasses the interval', () => {
    const now = Date.now();
    sweep.markSweepStarted({ now });
    expect(sweep.shouldSweep({ now: now + 1_000, force: true })).toBe(true);
  });

  it('marks the start time before the scan, so slow runs do not invite a pile-up', () => {
    const now = Date.now();
    sweep.markSweepStarted({ now });
    expect(sweep.readSweepState().lastSweepStartedAt).toBe(new Date(now).toISOString());
  });

  it('survives a corrupt state file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(sweep.SWEEP_STATE_PATH, 'not json');
    expect(sweep.shouldSweep()).toBe(true);
  });

  it('keeps the default interval when the env override is empty or junk', () => {
    // Number('') is 0, so a merely-present-and-empty variable would otherwise
    // disable the throttle and spawn a sweep on every turn.
    const now = Date.now();
    sweep.markSweepStarted({ now });

    for (const value of ['', '   ', 'abc', '-1']) {
      vi.stubEnv('AGENTBOARD_SWEEP_INTERVAL_MS', value);
      expect(sweep.shouldSweep({ now: now + 60_000 })).toBe(false);
    }

    vi.stubEnv('AGENTBOARD_SWEEP_INTERVAL_MS', '1000');
    expect(sweep.shouldSweep({ now: now + 60_000 })).toBe(true);
  });
});

describe('markSweepFinished', () => {
  it('records the last report for doctor/status to show', () => {
    sweep.markSweepFinished({ uploaded: 2, seeded: 5 });
    expect(sweep.readSweepState().lastReport).toEqual({ uploaded: 2, seeded: 5 });
  });
});

describe('maybeSpawnSweep', () => {
  it('refuses to spawn under the recursion guard', () => {
    expect(sweep.maybeSpawnSweep({}, { AGENTBOARD_INTERNAL: '1' })).toBe(false);
  });

  it('refuses when the env kill switch is set', () => {
    expect(sweep.maybeSpawnSweep({}, { AGENTBOARD_SWEEP: 'off' })).toBe(false);
  });

  it('refuses while throttled', () => {
    sweep.markSweepStarted();
    expect(sweep.maybeSpawnSweep({}, {})).toBe(false);
  });
});
