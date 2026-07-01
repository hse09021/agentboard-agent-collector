/**
 * Tests for plugin/hooks/lib/usage-limit.mjs
 *
 * These lock in safety properties around headless CLI invocation:
 * - `codex exec "/status"` does not query status headlessly — it runs a
 *   real, billable agent turn (see /codex.md). `codexStatusCommand()` stays
 *   permanently unused; it must never be reachable from
 *   `captureUsageLimitSnapshot`.
 * - Codex rate limits ARE captured, but via `codex app-server`'s stdio
 *   JSON-RPC `account/rateLimits/read` — verified 2026-07-01 to never open
 *   a `thread/start` (no session/turn) and to return identical
 *   `usedPercent` across repeated calls (no quota drift). Architecturally
 *   unrelated to `codex exec`.
 * - `claude -p "/usage"` (via spawn(), no shell) was verified 2026-07-01 to
 *   be a local, non-billable status read (session transcript shows a
 *   `local_command` entry with zero assistant turns).
 * - Both sources are ON by default and only opt out via an explicit "0".
 *
 * The collector (real subprocess spawn) and throttle (real
 * ~/.agentboard/usage-limit-state.json) are mocked here so this suite only
 * exercises the gating logic, not a live CLI call or disk state mutation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../plugin/hooks/lib/usage-limit-collector.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    captureUsageLimitRaw: vi.fn(async () => ({
      ok: true,
      raw: 'Current session: 10% used\nCurrent week (all models): 5% used',
      exitCode: 0,
      durationMs: 5,
    })),
    readClaudeSubscriptionPlan: vi.fn(() => 'pro'),
    readCodexRateLimits: vi.fn(async () => ({
      ok: true,
      raw: '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":11,"windowDurationMins":300,"resetsAt":1782900148},"secondary":{"usedPercent":2,"windowDurationMins":10080,"resetsAt":1783486948},"planType":"plus"}}}',
      result: {
        rateLimits: {
          primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1782900148 },
          secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1783486948 },
          planType: 'plus',
        },
      },
      durationMs: 5,
    })),
  };
});

vi.mock('../../plugin/hooks/lib/usage-limit-throttle.mjs', () => ({
  shouldCaptureUsageLimit: vi.fn(() => true),
  markUsageLimitCaptured: vi.fn(),
}));

const { captureUsageLimitSnapshot } = await import('../../plugin/hooks/lib/usage-limit.mjs');

const ENV_KEY = 'AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE';
let originalEnv;

beforeEach(() => {
  originalEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  vi.clearAllMocks();
});

describe('captureUsageLimitSnapshot — safety gating', () => {
  it('captures for codex by default via app-server, not codex exec', async () => {
    delete process.env[ENV_KEY];
    const result = await captureUsageLimitSnapshot('codex');
    expect(result).not.toBeNull();
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(89);
    expect(result.weeklyRemainingPct).toBe(98);
  });

  it('no-ops for codex when explicitly disabled via "0"', async () => {
    process.env[ENV_KEY] = '0';
    const result = await captureUsageLimitSnapshot('codex');
    expect(result).toBeNull();
  });

  it('captures for claude_code by default (on by default, not opt-in)', async () => {
    delete process.env[ENV_KEY];
    const result = await captureUsageLimitSnapshot('claude_code');
    expect(result).not.toBeNull();
    expect(result.parseOk).toBe(true);
    expect(result.planName).toBe('pro');
  });

  it('no-ops for claude_code when explicitly disabled via "0"', async () => {
    process.env[ENV_KEY] = '0';
    const result = await captureUsageLimitSnapshot('claude_code');
    expect(result).toBeNull();
  });

  it('no-ops for an unknown source regardless of opt-in', async () => {
    process.env[ENV_KEY] = '1';
    const result = await captureUsageLimitSnapshot('opencode');
    expect(result).toBeNull();
  });
});
