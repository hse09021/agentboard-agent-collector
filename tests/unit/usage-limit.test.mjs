/**
 * Tests for plugin/hooks/lib/usage-limit.mjs
 *
 * These lock in a safety property discovered 2026-07-01 (see /codex.md):
 * `codex exec "/status"` does not query status headlessly — it runs a
 * real, billable agent turn. So `captureUsageLimitSnapshot('codex')` must
 * ALWAYS no-op (never spawn anything), regardless of env config. Claude
 * Code capture is unverified too, so it must default OFF and only run
 * when explicitly opted in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureUsageLimitSnapshot } from '../../plugin/hooks/lib/usage-limit.mjs';

const ENV_KEY = 'AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE';
let originalEnv;

beforeEach(() => {
  originalEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe('captureUsageLimitSnapshot — safety gating', () => {
  it('always no-ops for codex, even when capture is opted in', async () => {
    process.env[ENV_KEY] = '1';
    const result = await captureUsageLimitSnapshot('codex');
    expect(result).toBeNull();
  });

  it('no-ops for claude_code by default (capture not opted in)', async () => {
    delete process.env[ENV_KEY];
    const result = await captureUsageLimitSnapshot('claude_code');
    expect(result).toBeNull();
  });

  it('no-ops for an unknown source regardless of opt-in', async () => {
    process.env[ENV_KEY] = '1';
    const result = await captureUsageLimitSnapshot('opencode');
    expect(result).toBeNull();
  });
});
