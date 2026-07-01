/**
 * Tests for plugin/hooks/lib/usage-limit-collector.mjs
 */

import { describe, it, expect } from 'vitest';
import { captureUsageLimitRaw } from '../../plugin/hooks/lib/usage-limit-collector.mjs';

describe('captureUsageLimitRaw', () => {
  it('captures stdout on a successful command', async () => {
    const result = await captureUsageLimitRaw({
      command: process.execPath,
      args: ['-e', "process.stdout.write('5-hour limit: 42% remaining')"],
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('42%');
    expect(result.exitCode).toBe(0);
  });

  it('does not throw and reports failure on non-zero exit', async () => {
    const result = await captureUsageLimitRaw({
      command: process.execPath,
      args: ['-e', "process.stdout.write('partial'); process.exit(1)"],
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.raw).toContain('partial');
  });

  it('does not throw and reports failure when the command does not exist', async () => {
    const result = await captureUsageLimitRaw({
      command: 'agentboard-definitely-not-a-real-binary',
      args: [],
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.raw).toBe('');
    expect(result.error).toBeTruthy();
  });

  it('respects the timeout and kills a hanging process', async () => {
    const result = await captureUsageLimitRaw({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(result.durationMs).toBeLessThan(5000);
  }, 10000);
});
