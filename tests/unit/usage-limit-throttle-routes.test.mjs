import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldCaptureUsageLimit,
  markUsageLimitCaptured,
  getUsageLimitStatePath,
} from '../../plugin/hooks/lib/usage-limit-throttle.mjs';

const MINUTE = 60_000;

describe('usage-limit throttle — per route', () => {
  let configDir;
  let statePath;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'agentboard-throttle-'));
    statePath = getUsageLimitStatePath(configDir);
  });

  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it('captures for a fresh source and route', () => {
    expect(shouldCaptureUsageLimit('claude_code', { configDir, route: 'acme' })).toBe(true);
  });

  // The point of the per-route key: a snapshot only ever reaches the route it
  // was captured for, so a developer alternating between projects must not
  // leave one server without a reading.
  it('lets a different route capture even inside the 10-minute window', () => {
    const t0 = Date.now();
    markUsageLimitCaptured('claude_code', { configDir, route: 'acme', now: t0 });

    // Same route, two minutes later — still throttled.
    expect(
      shouldCaptureUsageLimit('claude_code', { configDir, route: 'acme', now: t0 + 2 * MINUTE })
    ).toBe(false);

    // Different route, same moment past the global floor — allowed.
    expect(
      shouldCaptureUsageLimit('claude_code', { configDir, route: 'default', now: t0 + 2 * MINUTE })
    ).toBe(true);
  });

  // Without a floor, alternating between two projects would spawn a capture on
  // every switch.
  it('holds every route to the global floor', () => {
    const t0 = Date.now();
    markUsageLimitCaptured('claude_code', { configDir, route: 'acme', now: t0 });

    expect(
      shouldCaptureUsageLimit('claude_code', { configDir, route: 'default', now: t0 + 10_000 })
    ).toBe(false);
    expect(
      shouldCaptureUsageLimit('claude_code', { configDir, route: 'default', now: t0 + 91_000 })
    ).toBe(true);
  });

  it('releases the same route after the interval', () => {
    const t0 = Date.now();
    markUsageLimitCaptured('codex', { configDir, route: 'acme', now: t0 });
    expect(
      shouldCaptureUsageLimit('codex', { configDir, route: 'acme', now: t0 + 11 * MINUTE })
    ).toBe(true);
  });

  // SessionEnd wants a fresh resting value, but must not be able to bypass the
  // cost bound.
  it('lets minIntervalMs 0 bypass the route cadence but not the floor', () => {
    const t0 = Date.now();
    markUsageLimitCaptured('claude_code', { configDir, route: 'acme', now: t0 });

    expect(
      shouldCaptureUsageLimit('claude_code', {
        configDir, route: 'acme', minIntervalMs: 0, now: t0 + 10_000,
      })
    ).toBe(false);

    expect(
      shouldCaptureUsageLimit('claude_code', {
        configDir, route: 'acme', minIntervalMs: 0, now: t0 + 91_000,
      })
    ).toBe(true);
  });

  it('keeps sources independent', () => {
    const t0 = Date.now();
    markUsageLimitCaptured('claude_code', { configDir, route: 'acme', now: t0 });
    expect(
      shouldCaptureUsageLimit('codex', { configDir, route: 'acme', now: t0 + 1000 })
    ).toBe(true);
  });

  describe('v1 state migration', () => {
    it('honours an existing v1 timestamp as the source floor', () => {
      const recent = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify({ claude_code: { lastCapturedAt: recent } }));

      // The v1 value lands in `sources`, so the floor applies immediately...
      expect(shouldCaptureUsageLimit('claude_code', { configDir, route: 'acme' })).toBe(false);

      // ...and once past the floor the empty `routes` map lets it capture.
      expect(
        shouldCaptureUsageLimit('claude_code', {
          configDir, route: 'acme', now: Date.now() + 91_000,
        })
      ).toBe(true);
    });

    it('writes the v2 shape after the first capture', () => {
      writeFileSync(statePath, JSON.stringify({ codex: { lastCapturedAt: new Date(0).toISOString() } }));
      markUsageLimitCaptured('codex', { configDir, route: 'acme' });

      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state.version).toBe(2);
      expect(state.sources.codex.lastCapturedAt).toBeTruthy();
      expect(state.routes['codex:acme'].lastCapturedAt).toBeTruthy();
    });

    it('tolerates a corrupt state file', () => {
      writeFileSync(statePath, 'not json at all');
      expect(shouldCaptureUsageLimit('codex', { configDir, route: 'acme' })).toBe(true);
    });
  });

  it('writes state atomically, leaving no temp file behind', () => {
    markUsageLimitCaptured('codex', { configDir, route: 'acme' });
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(`${statePath}.${process.pid}.tmp`)).toBe(false);
  });
});
