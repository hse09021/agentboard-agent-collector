/**
 * Tests for plugin/hooks/lib/usage-limit-collector.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureUsageLimitRaw,
  claudeCredentialsPath,
  claudeKeychainService,
  claudeProfilePath,
  detectClaudeSubscriptionPlan,
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

  it('injects AGENTBOARD_INTERNAL=1 into the spawned child so its hooks self-skip', async () => {
    // `claude -p /usage` starts a headless Claude Code session that fires this
    // collector's own Stop/SessionEnd hooks. That recursion is broken by
    // tagging the child's env; the hook entry points bail on this flag. Prove
    // the child actually receives it.
    const result = await captureUsageLimitRaw({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.AGENTBOARD_INTERNAL ?? "unset")'],
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.raw).toBe('1');
  });
});

// Every test below points the profile at a path that does not exist unless it
// writes one, so the real ~/.claude.json never leaks in.
const MISSING_PROFILE = '/path/that/does/not/exist/.claude.json';

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
      expect(readClaudeSubscriptionPlan({ profilePath: MISSING_PROFILE, credentialsPath })).toBe('pro');
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
      expect(readClaudeSubscriptionPlan({ profilePath: MISSING_PROFILE, credentialsPath })).toBe('max20x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for missing or unrecognized credential data', () => {
    // Inject an empty Keychain reader so this stays deterministic on macOS,
    // where the default reader would otherwise hit the real login Keychain.
    expect(
      readClaudeSubscriptionPlan({
        profilePath: MISSING_PROFILE,
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
        profilePath: MISSING_PROFILE,
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
      expect(
        readClaudeSubscriptionPlan({ profilePath: MISSING_PROFILE, credentialsPath, keychainReader })
      ).toBe('max20x');
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
        profilePath: MISSING_PROFILE,
        credentialsPath: '/path/that/does/not/exist',
        keychainReader,
      })
    ).toBeUndefined();
  });
});

// The scenario from #18: Max 5x at sign-in, downgraded to Pro on claude.ai
// without signing in again. The credentials still say Max; .claude.json was
// refreshed on the next Claude Code start.
describe('detectClaudeSubscriptionPlan — .claude.json first', () => {
  const STALE_MAX_CREDENTIALS = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-secret',
      refreshToken: 'sk-ant-ort01-secret',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    },
  });

  // Shaped like the real file: the plan fields sit next to account details
  // that must never come out of the reader.
  function profile(oauthAccount) {
    return JSON.stringify({
      numStartups: 42,
      projects: { '/Users/someone/secret-repo': { allowedTools: [] } },
      oauthAccount: {
        accountUuid: 'acc-uuid-1234',
        emailAddress: 'someone@example.com',
        displayName: 'Some One',
        organizationUuid: 'org-uuid-5678',
        organizationName: 'Secret Org Inc',
        ...oauthAccount,
      },
    });
  }

  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-claude-profile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Every location lives in `dir`; the Keychain reader records what it was asked for. */
  function detectIn(files, { env = { CLAUDE_CONFIG_DIR: dir }, keychain = '' } = {}) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const services = [];
    const result = detectClaudeSubscriptionPlan({
      env,
      keychainReader: (service) => {
        services.push(service);
        return keychain;
      },
    });
    return { result, services };
  }

  it('prefers .claude.json over stale sign-in credentials', () => {
    const { result } = detectIn(
      {
        '.claude.json': profile({ organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai' }),
        '.credentials.json': STALE_MAX_CREDENTIALS,
      },
      { keychain: STALE_MAX_CREDENTIALS }
    );
    expect(result).toEqual({ planName: 'pro', source: 'claude_json' });
  });

  it.each([
    ['claude_pro', 'default_claude_ai', 'pro'],
    ['claude_pro', undefined, 'pro'],
    ['claude_pro', 'default_claude_max_20x', 'pro'],
    ['claude_max', 'default_claude_max_5x', 'max5x'],
    ['claude_max', 'default_claude_max_20x', 'max20x'],
    ['claude_team', undefined, 'team'],
    ['claude_enterprise', undefined, 'enterprise'],
  ])('maps %s + %s to %s', (organizationType, organizationRateLimitTier, planName) => {
    const { result } = detectIn({
      '.claude.json': profile({ organizationType, organizationRateLimitTier }),
    });
    expect(result).toEqual({ planName, source: 'claude_json' });
  });

  it.each([
    ['claude_max with an unknown tier', { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_99x' }],
    ['claude_max without a tier', { organizationType: 'claude_max' }],
    ['claude_free', { organizationType: 'claude_free' }],
    ['an unknown organization type', { organizationType: 'claude_galaxy' }],
    ['a prototype key', { organizationType: 'constructor' }],
    ['a non-string type', { organizationType: { nested: 'claude_pro' } }],
    ['no organization type', {}],
  ])('falls back to the credentials for %s', (_label, oauthAccount) => {
    const { result } = detectIn({
      '.claude.json': profile(oauthAccount),
      '.credentials.json': STALE_MAX_CREDENTIALS,
    });
    expect(result).toEqual({ planName: 'max5x', source: 'credentials_file' });
  });

  it.each([
    ['no oauthAccount', JSON.stringify({ numStartups: 1 })],
    ['a half-written file', '{"oauthAccount": {"organizationType": "claude_'],
    ['an empty file', ''],
    ['JSON null', 'null'],
  ])('falls back to the credentials for %s', (_label, content) => {
    const { result } = detectIn({ '.claude.json': content, '.credentials.json': STALE_MAX_CREDENTIALS });
    expect(result).toEqual({ planName: 'max5x', source: 'credentials_file' });
  });

  it('without .claude.json, behaves as before: credentials file, then Keychain', () => {
    expect(detectIn({ '.credentials.json': STALE_MAX_CREDENTIALS }).result).toEqual({
      planName: 'max5x',
      source: 'credentials_file',
    });

    rmSync(join(dir, '.credentials.json'));
    expect(detectIn({}, { keychain: STALE_MAX_CREDENTIALS }).result).toEqual({
      planName: 'max5x',
      source: 'keychain',
    });
  });

  it('returns only the plan name and its source — no account field survives', () => {
    const { result } = detectIn({
      '.claude.json': profile({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }),
    });

    expect(Object.keys(result).sort()).toEqual(['planName', 'source']);
    const serialized = JSON.stringify(result);
    for (const secret of ['someone@example.com', 'Some One', 'Secret Org Inc', 'acc-uuid', 'org-uuid', 'secret-repo']) {
      expect(serialized).not.toContain(secret);
    }
    expect(readClaudeSubscriptionPlan({ env: { CLAUDE_CONFIG_DIR: dir }, keychainReader: () => '' })).toBe('max20x');
  });

  it("uses CLAUDE_CONFIG_DIR's .claude.json, credentials and suffixed Keychain item", () => {
    const expectedService = `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;

    // Nothing on disk: the Keychain is asked for this dir's own item.
    const { result, services } = detectIn({}, { keychain: STALE_MAX_CREDENTIALS });
    expect(services).toEqual([expectedService]);
    expect(result).toEqual({ planName: 'max5x', source: 'keychain' });

    // A .claude.json inside the dir is picked up without any path override.
    writeFileSync(join(dir, '.claude.json'), profile({ organizationType: 'claude_team' }));
    expect(detectIn({}).result).toEqual({ planName: 'team', source: 'claude_json' });
  });

  it('CLAUDE_SECURESTORAGE_CONFIG_DIR decides the credentials dir and Keychain suffix, not .claude.json', () => {
    const secureDir = mkdtempSync(join(tmpdir(), 'agentboard-claude-secure-'));
    try {
      writeFileSync(join(secureDir, '.credentials.json'), STALE_MAX_CREDENTIALS);
      const env = { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir };

      // Credentials come from the secure-storage dir, not CLAUDE_CONFIG_DIR.
      expect(detectIn({}, { env }).result).toEqual({ planName: 'max5x', source: 'credentials_file' });

      // ...and the Keychain suffix hashes it too.
      rmSync(join(secureDir, '.credentials.json'));
      const { services } = detectIn({}, { env });
      expect(services).toEqual([
        `Claude Code-credentials-${createHash('sha256').update(secureDir).digest('hex').slice(0, 8)}`,
      ]);

      // .claude.json still follows CLAUDE_CONFIG_DIR.
      writeFileSync(join(dir, '.claude.json'), profile({ organizationType: 'claude_pro' }));
      expect(detectIn({}, { env }).result).toEqual({ planName: 'pro', source: 'claude_json' });
    } finally {
      rmSync(secureDir, { recursive: true, force: true });
    }
  });
});

describe('Claude Code locations', () => {
  it('puts .claude.json in the home directory itself, not ~/.claude/', () => {
    expect(claudeProfilePath({})).toBe(join(homedir(), '.claude.json'));
    expect(claudeProfilePath({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude.json'));
    expect(claudeProfilePath({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt' })).toBe(join('/tmp/claude-alt', '.claude.json'));
    // The secure-storage dir only moves credentials.
    expect(claudeProfilePath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/secure-alt' })).toBe(
      join(homedir(), '.claude.json')
    );
  });

  it('puts .credentials.json in the secure-storage dir, else the config dir', () => {
    expect(claudeCredentialsPath({})).toBe(join(homedir(), '.claude', '.credentials.json'));
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt' })).toBe(
      join('/tmp/claude-alt', '.credentials.json')
    );
    expect(
      claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/secure-alt' })
    ).toBe(join('/tmp/secure-alt', '.credentials.json'));
    // Defined but empty means the default dir, even with CLAUDE_CONFIG_DIR set.
    expect(
      claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })
    ).toBe(join(homedir(), '.claude', '.credentials.json'));
  });

  // Expected suffixes are sha256 of the literal strings, computed once by hand,
  // so a change in what gets hashed shows up here.
  it.each([
    ['no override', {}, 'Claude Code-credentials'],
    ['an empty CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: '' }, 'Claude Code-credentials'],
    ['CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: '/tmp/claude-alt' }, 'Claude Code-credentials-04923786'],
    [
      'CLAUDE_SECURESTORAGE_CONFIG_DIR over CLAUDE_CONFIG_DIR',
      { CLAUDE_CONFIG_DIR: '/tmp/claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/secure-alt' },
      'Claude Code-credentials-c8a84914',
    ],
    ['CLAUDE_SECURESTORAGE_CONFIG_DIR alone', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/secure-alt' }, 'Claude Code-credentials-c8a84914'],
    [
      'an empty CLAUDE_SECURESTORAGE_CONFIG_DIR, which drops the suffix',
      { CLAUDE_CONFIG_DIR: '/tmp/claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      'Claude Code-credentials',
    ],
    // Claude Code NFC-normalizes before hashing: a decomposed "é" (as some
    // filesystems hand it back) must name the same item as a composed one.
    ['a decomposed accent', { CLAUDE_CONFIG_DIR: '/Users/me/café' }, 'Claude Code-credentials-12e72a48'],
    ['a composed accent', { CLAUDE_CONFIG_DIR: '/Users/me/café' }, 'Claude Code-credentials-12e72a48'],
  ])('names the Keychain item for %s', (_label, env, service) => {
    expect(claudeKeychainService(env)).toBe(service);
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
