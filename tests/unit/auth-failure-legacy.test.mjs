/**
 * The legacy-token notice (issue #7), on the two behaviours that are easy to
 * get wrong once the notice repeats every session:
 *
 *   - it must not rewrite an unchanged record — hooks run constantly, and a
 *     moving `at` hides how long the problem has been true
 *   - it must not read as "renewal failed", which describes an attempt that
 *     never happened for a token that was never renewable
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let configDir;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-auth-failure-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

const LEGACY_REASON = 'stored token predates refresh support';

describe('recordAuthFailure', () => {
  it('keeps the first timestamp when the same reason repeats', async () => {
    const { recordAuthFailure, AUTH_FAILURE_PATH } = await import(
      '../../plugin/hooks/lib/auth-failure.mjs'
    );

    recordAuthFailure({ reason: LEGACY_REASON, source: 'claude' });
    const first = JSON.parse(readFileSync(AUTH_FAILURE_PATH, 'utf-8'));

    // 훅이 다음 세션에서 또 부른다. 같은 상황이므로 파일은 그대로여야 한다.
    await new Promise((r) => setTimeout(r, 5));
    recordAuthFailure({ reason: LEGACY_REASON, source: 'claude' });
    const second = JSON.parse(readFileSync(AUTH_FAILURE_PATH, 'utf-8'));

    expect(second.at).toBe(first.at);
  });

  it('replaces the record when the reason changes', async () => {
    const { recordAuthFailure, AUTH_FAILURE_PATH } = await import(
      '../../plugin/hooks/lib/auth-failure.mjs'
    );

    recordAuthFailure({ reason: LEGACY_REASON });
    recordAuthFailure({ reason: 'refresh token rejected (401)' });

    const record = JSON.parse(readFileSync(AUTH_FAILURE_PATH, 'utf-8'));
    expect(record.reason).toBe('refresh token rejected (401)');
  });
});

describe('describeAuthFailure', () => {
  it('does not claim a renewal was attempted for a legacy token', async () => {
    const { describeAuthFailure } = await import('../../src/core/auth-failure');

    const message = describeAuthFailure({ at: '2026-09-12T00:00:00Z', reason: LEGACY_REASON });

    expect(message).not.toMatch(/renewal failed/i);
    expect(message.toLowerCase()).toContain('cannot be renewed automatically');
  });

  it('still reports a rejected refresh token as a renewal failure', async () => {
    const { describeAuthFailure } = await import('../../src/core/auth-failure');

    const message = describeAuthFailure({
      at: '2026-09-12T00:00:00Z',
      reason: 'refresh token rejected (401)',
    });

    expect(message).toMatch(/renewal failed/i);
    expect(message).toContain('refresh token rejected (401)');
  });
});
