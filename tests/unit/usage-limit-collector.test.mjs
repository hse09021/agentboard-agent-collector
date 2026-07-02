/**
 * Tests for plugin/hooks/lib/usage-limit-collector.mjs
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureUsageLimitRaw,
  readClaudeSubscriptionPlan,
  readCodexRateLimits,
} from '../../plugin/hooks/lib/usage-limit-collector.mjs';

// A fake `codex app-server` speaking the same newline-delimited JSON-RPC
// framing over stdio, so readCodexRateLimits() is exercised through a real
// process + real pipes (matching this file's existing style) without
// depending on the actual codex binary being installed. `-e` scripts are
// passed as a single line, so this is written without embedded newlines.
const FAKE_APP_SERVER_SCRIPT =
  "let buf=''; process.stdin.on('data', c => { buf += c; let i; " +
  "while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); " +
  "if (!line.trim()) continue; const msg = JSON.parse(line); " +
  "if (msg.id === 1) { process.stdout.write(JSON.stringify({id:1,result:{}}) + '\\n'); } " +
  "else if (msg.id === 2) { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:11,windowDurationMins:300,resetsAt:1782900148},secondary:{usedPercent:2,windowDurationMins:10080,resetsAt:1783486948},planType:'plus'}}}) + '\\n'); } } });";

const FAKE_APP_SERVER_NOT_INITIALIZED_SCRIPT =
  "let buf=''; process.stdin.on('data', c => { buf += c; let i; " +
  "while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); " +
  "if (!line.trim()) continue; const msg = JSON.parse(line); " +
  "if (msg.id === 2) { process.stdout.write(JSON.stringify({id:2,error:{code:-32600,message:'Not initialized'}}) + '\\n'); } } });";

function fakeAppServerSpawn(script) {
  // Force shell:false regardless of what the real codexAppServerSpawnOptions()
  // picked for this platform — we're spawning node.exe directly (a real
  // executable, not a .cmd shim), and shell:true would mangle the script's
  // semicolons/quotes if invoked through cmd.exe.
  return (_command, _args, options) =>
    spawn(process.execPath, ['-e', script], { ...options, shell: false });
}

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

describe('readClaudeSubscriptionPlan', () => {
  it('reads only the normalized subscription type from Claude credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-claude-credentials-'));
    const credentialsPath = join(dir, '.credentials.json');
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-secret',
          refreshToken: 'sk-ant-ort01-secret',
          subscriptionType: 'pro',
          rateLimitTier: 'default_claude_ai',
        },
      })
    );

    try {
      expect(readClaudeSubscriptionPlan({ credentialsPath })).toBe('pro');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses rateLimitTier when subscriptionType is too broad to identify a Max tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-claude-credentials-'));
    const credentialsPath = join(dir, '.credentials.json');
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          subscriptionType: 'max',
          rateLimitTier: 'claude_ai_max_20x',
        },
      })
    );

    try {
      expect(readClaudeSubscriptionPlan({ credentialsPath })).toBe('max20x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for missing or unrecognized credential data', () => {
    // Inject an empty Keychain reader so this stays deterministic on macOS,
    // where the default reader would otherwise hit the real login Keychain.
    expect(
      readClaudeSubscriptionPlan({
        credentialsPath: '/path/that/does/not/exist',
        keychainReader: () => '',
      })
    ).toBeUndefined();
  });

  it('falls back to the macOS Keychain when the credentials file is absent', () => {
    // Mirrors macOS, where Claude Code stores creds in the Keychain and does
    // not write ~/.claude/.credentials.json.
    const keychainReader = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-secret',
          subscriptionType: 'pro',
          rateLimitTier: 'default_claude_ai',
        },
      });

    expect(
      readClaudeSubscriptionPlan({
        credentialsPath: '/path/that/does/not/exist',
        keychainReader,
      })
    ).toBe('pro');
  });

  it('prefers the credentials file over the Keychain when both are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-claude-credentials-'));
    const credentialsPath = join(dir, '.credentials.json');
    writeFileSync(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'claude_ai_max_20x' } })
    );
    const keychainReader = () => JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } });

    try {
      expect(readClaudeSubscriptionPlan({ credentialsPath, keychainReader })).toBe('max20x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when the Keychain reader fails', () => {
    const keychainReader = () => {
      throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found.');
    };

    expect(
      readClaudeSubscriptionPlan({
        credentialsPath: '/path/that/does/not/exist',
        keychainReader,
      })
    ).toBeUndefined();
  });
});

describe('readCodexRateLimits', () => {
  it('pipelines initialize + account/rateLimits/read and returns the structured result', async () => {
    const result = await readCodexRateLimits({
      timeoutMs: 5000,
      spawnImpl: fakeAppServerSpawn(FAKE_APP_SERVER_SCRIPT),
    });
    expect(result.ok).toBe(true);
    expect(result.result.rateLimits.primary.usedPercent).toBe(11);
    expect(result.result.rateLimits.secondary.usedPercent).toBe(2);
    expect(result.result.rateLimits.planType).toBe('plus');
  });

  it('surfaces a JSON-RPC error (e.g. "Not initialized") as ok:false rather than throwing', async () => {
    const result = await readCodexRateLimits({
      timeoutMs: 5000,
      spawnImpl: fakeAppServerSpawn(FAKE_APP_SERVER_NOT_INITIALIZED_SCRIPT),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not initialized');
  });

  it('does not throw and reports failure when the command does not exist', async () => {
    const result = await readCodexRateLimits({
      timeoutMs: 5000,
      spawnImpl: () => {
        throw new Error('spawn codex.cmd ENOENT');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('respects the timeout and kills a hanging app-server process', async () => {
    const hangingScript = "process.stdin.on('data', () => {}); setTimeout(() => {}, 60000);";
    const result = await readCodexRateLimits({
      timeoutMs: 300,
      spawnImpl: fakeAppServerSpawn(hangingScript),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(result.durationMs).toBeLessThan(5000);
  }, 10000);
});
