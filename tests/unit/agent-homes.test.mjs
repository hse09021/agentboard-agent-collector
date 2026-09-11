/**
 * Tests for plugin/hooks/lib/agent-homes.mjs — the registry that answers
 * "which agent config homes exist on this machine".
 *
 * This is the module that fixes the orchestrator blind spot: Orca runs Codex
 * with CODEX_HOME pointed elsewhere, so a collector that only ever looks at
 * homedir() finds neither its hooks nor the transcripts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let mod;
let configMod;

async function reimport() {
  vi.resetModules();
  configMod = await import('../../plugin/hooks/lib/config.mjs');
  mod = await import('../../plugin/hooks/lib/agent-homes.mjs');
  mkdirSync(configMod.CONFIG_DIR, { recursive: true });
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-homes-test-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  await reimport();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('recordAgentHome', () => {
  it('is idempotent under path normalization', () => {
    const dir = join(homeDir, 'alt-codex');
    mkdirSync(dir, { recursive: true });

    expect(mod.recordAgentHome('codex', dir, 'runtime')).toBe(true);
    // Trailing separator and forward slashes must resolve to the same entry.
    expect(mod.recordAgentHome('codex', dir + '/', 'runtime')).toBe(false);
    expect(mod.recordAgentHome('codex', dir.replace(/\\/g, '/'), 'runtime')).toBe(false);

    expect(mod.loadAgentHomes().homes.filter((h) => h.kind === 'codex')).toHaveLength(1);
  });

  it('upgrades a runtime-observed home to install, but never downgrades', () => {
    const dir = join(homeDir, 'alt-codex');
    mkdirSync(dir, { recursive: true });

    mod.recordAgentHome('codex', dir, 'runtime');
    mod.recordAgentHome('codex', dir, 'install');
    expect(mod.loadAgentHomes().homes[0].origin).toBe('install');

    mod.recordAgentHome('codex', dir, 'runtime');
    expect(mod.loadAgentHomes().homes[0].origin).toBe('install');
  });

  it('evicts the oldest non-default entries past MAX_HOMES_PER_KIND', () => {
    for (let i = 0; i < mod.MAX_HOMES_PER_KIND + 4; i++) {
      const dir = join(homeDir, `codex-${String(i).padStart(3, '0')}`);
      mkdirSync(dir, { recursive: true });
      mod.recordAgentHome('codex', dir, 'runtime');
    }
    const homes = mod.loadAgentHomes().homes.filter((h) => h.kind === 'codex');
    expect(homes.length).toBeLessThanOrEqual(mod.MAX_HOMES_PER_KIND);
    // The most recent survive.
    expect(homes.some((h) => h.dir.endsWith('019'))).toBe(true);
  });

  it('never writes config.json — hooks must keep promoting v1 in memory', () => {
    const configPath = configMod.CONFIG_PATH;
    const before = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;

    const dir = join(homeDir, 'alt-codex');
    mkdirSync(dir, { recursive: true });
    mod.recordAgentHome('codex', dir, 'runtime');

    const after = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
    expect(after).toBe(before);
  });
});

describe('recordAgentHomesFromEnv', () => {
  it('records the home the current process is running under', async () => {
    const codexHome = join(homeDir, 'orca-codex');
    const claudeHome = join(homeDir, 'orca-claude');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });

    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    await reimport();

    mod.recordAgentHomesFromEnv();

    const homes = mod.loadAgentHomes().homes;
    expect(homes.find((h) => h.kind === 'codex')?.origin).toBe('runtime');
    expect(homes.find((h) => h.kind === 'claude_code')?.origin).toBe('runtime');
  });

  it('does nothing when neither variable is set', () => {
    mod.recordAgentHomesFromEnv({});
    expect(mod.loadAgentHomes().homes).toHaveLength(0);
  });
});

describe('listAgentHomes', () => {
  it('always offers the default home and puts the env home first', async () => {
    const envHome = join(homeDir, 'orca-codex');
    mkdirSync(join(envHome, 'sessions'), { recursive: true });
    mkdirSync(join(homeDir, '.codex', 'sessions'), { recursive: true });

    vi.stubEnv('CODEX_HOME', envHome);
    await reimport();

    const homes = mod.listAgentHomes('codex');
    expect(homes[0].origin).toBe('runtime');
    expect(homes.some((h) => h.origin === 'default')).toBe(true);
  });

  it('filters out homes that do not exist', () => {
    mod.recordAgentHome('codex', join(homeDir, 'gone'), 'runtime');
    expect(mod.listAgentHomes('codex').some((h) => h.dir.endsWith('gone'))).toBe(false);
    expect(
      mod.listAgentHomes('codex', { includeMissing: true }).some((h) => h.dir.endsWith('gone'))
    ).toBe(true);
  });

  it('deduplicates the env home against an identical registry entry', async () => {
    const dir = join(homeDir, 'orca-codex');
    mkdirSync(dir, { recursive: true });
    mod.recordAgentHome('codex', dir, 'install');

    vi.stubEnv('CODEX_HOME', dir + '/');
    await reimport();

    expect(mod.listAgentHomes('codex').filter((h) => h.dir.includes('orca-codex'))).toHaveLength(1);
  });
});

describe('Orca managed account homes', () => {
  // Orca stores each hot-swapped account under <userData>/<agent>-accounts/<id>/
  // and points CODEX_HOME / CLAUDE_CONFIG_DIR at it, so that account's settings
  // and transcripts never land under ~/. The two agents differ in both the leaf
  // directory and the marker file Orca writes to identify one.
  const LAYOUT = {
    claude_code: { dir: 'claude-accounts', leaf: 'auth', marker: '.orca-managed-claude-auth' },
    codex: { dir: 'codex-accounts', leaf: 'home', marker: '.orca-managed-home' },
  };

  function makeAccount(kind, id, { marker = true } = {}) {
    const l = LAYOUT[kind];
    const home = join(homeDir, 'AppData', 'Roaming', 'Orca', l.dir, id, l.leaf);
    mkdirSync(home, { recursive: true });
    if (marker) writeFileSync(join(home, l.marker), id + '\n');
    return home;
  }

  it('finds a managed Claude account and offers it for sweeping', async () => {
    makeAccount('claude_code', 'acct-1');
    await reimport();

    expect(mod.orcaClaudeHomes()).toHaveLength(1);
    expect(mod.listAgentHomes('claude_code').some((h) => h.origin === 'orca')).toBe(true);
  });

  it('finds a managed Codex account alongside the shared runtime home', async () => {
    const runtime = join(homeDir, 'AppData', 'Roaming', 'Orca', 'codex-runtime-home', 'home');
    mkdirSync(runtime, { recursive: true });
    makeAccount('codex', 'acct-1');
    await reimport();

    expect(mod.orcaCodexHomes()).toHaveLength(2);
  });

  it('finds every configured account', async () => {
    makeAccount('claude_code', 'acct-1');
    makeAccount('claude_code', 'acct-2');
    await reimport();

    expect(mod.orcaClaudeHomes()).toHaveLength(2);
  });

  it('ignores a directory without the marker Orca writes', async () => {
    makeAccount('claude_code', 'not-orca', { marker: false });
    makeAccount('codex', 'not-orca', { marker: false });
    await reimport();

    expect(mod.orcaClaudeHomes()).toHaveLength(0);
    expect(mod.orcaCodexHomes()).toHaveLength(0);
  });

  it('does not accept a Claude marker in a Codex account, or the reverse', async () => {
    // The two layouts are distinct; a mixed-up marker must not qualify.
    const codexHome = join(homeDir, 'AppData', 'Roaming', 'Orca', 'codex-accounts', 'x', 'home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, '.orca-managed-claude-auth'), 'x\n');
    await reimport();

    expect(mod.orcaCodexHomes()).toHaveLength(0);
  });

  it('returns nothing when Orca has no managed accounts', () => {
    expect(mod.orcaClaudeHomes()).toEqual([]);
  });
});

describe('noteMissingHomes', () => {
  it('evicts only after MAX_MISS_COUNT consecutive misses', async () => {
    const dir = join(homeDir, 'flaky');
    mkdirSync(dir, { recursive: true });
    mod.recordAgentHome('codex', dir, 'runtime');
    rmSync(dir, { recursive: true, force: true });

    const { normalizePath } = await import('../../plugin/hooks/lib/path-normalize.mjs');
    const key = normalizePath(dir);

    for (let i = 0; i < mod.MAX_MISS_COUNT - 1; i++) {
      mod.noteMissingHomes([key]);
      expect(mod.loadAgentHomes().homes).toHaveLength(1);
    }
    mod.noteMissingHomes([key]);
    expect(mod.loadAgentHomes().homes).toHaveLength(0);
  });

  it('resets the miss count when the home comes back', async () => {
    const dir = join(homeDir, 'flaky');
    mkdirSync(dir, { recursive: true });
    mod.recordAgentHome('codex', dir, 'runtime');

    const { normalizePath } = await import('../../plugin/hooks/lib/path-normalize.mjs');
    mod.noteMissingHomes([normalizePath(dir)]);
    expect(mod.loadAgentHomes().homes[0].missCount).toBe(1);

    mod.recordAgentHome('codex', dir, 'runtime');
    expect(mod.loadAgentHomes().homes[0].missCount).toBeUndefined();
  });
});

describe('getCodexSessionsDirs / getClaudeProjectsDirs', () => {
  it('returns <home>/sessions and <home>/projects for every existing home', async () => {
    const orca = join(homeDir, 'orca-codex');
    mkdirSync(join(orca, 'sessions'), { recursive: true });
    mkdirSync(join(homeDir, '.codex', 'sessions'), { recursive: true });
    mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });

    vi.stubEnv('CODEX_HOME', orca);
    await reimport();

    expect(mod.getCodexSessionsDirs()).toHaveLength(2);
    expect(mod.getCodexSessionsDirs()[0]).toContain('orca-codex');
    expect(mod.getClaudeProjectsDirs()).toHaveLength(1);
  });
});
