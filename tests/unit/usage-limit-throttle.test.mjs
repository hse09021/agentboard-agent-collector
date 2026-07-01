/**
 * Tests for plugin/hooks/lib/usage-limit-throttle.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  shouldCaptureUsageLimit,
  markUsageLimitCaptured,
  getUsageLimitStatePath,
} from '../../plugin/hooks/lib/usage-limit-throttle.mjs';

let configDir;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-throttle-test-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('shouldCaptureUsageLimit', () => {
  it('returns true when no prior state exists', () => {
    expect(shouldCaptureUsageLimit('claude_code', { configDir })).toBe(true);
  });

  it('returns false right after a capture within the min interval', () => {
    markUsageLimitCaptured('claude_code', { configDir });
    expect(shouldCaptureUsageLimit('claude_code', { configDir, minIntervalMs: 15 * 60_000 })).toBe(false);
  });

  it('returns true once the min interval has elapsed', () => {
    const statePath = getUsageLimitStatePath(configDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ claude_code: { lastCapturedAt: new Date(Date.now() - 20 * 60_000).toISOString() } })
    );
    expect(shouldCaptureUsageLimit('claude_code', { configDir, minIntervalMs: 15 * 60_000 })).toBe(true);
  });

  it('tracks sources independently', () => {
    markUsageLimitCaptured('claude_code', { configDir });
    expect(shouldCaptureUsageLimit('claude_code', { configDir })).toBe(false);
    expect(shouldCaptureUsageLimit('codex', { configDir })).toBe(true);
  });

  it('treats a corrupt state file as no prior capture', () => {
    const statePath = getUsageLimitStatePath(configDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(statePath, '{not valid json');
    expect(shouldCaptureUsageLimit('claude_code', { configDir })).toBe(true);
  });
});
