/**
 * Multi-home resolution in plugin/hooks/codex/parse-codex.mjs.
 *
 * This is the regression test for the Orca bug: Codex honours CODEX_HOME, and
 * an orchestrator points it at its own runtime home, so a lookup rooted at
 * homedir() finds nothing. It also pins the removal of the "newest rollout
 * anywhere" fallback, which used to hand the caller an unrelated session whose
 * tokens were then diffed against another thread's ledger entry and routed to
 * that thread's server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let parseCodex;

function writeRollout(home, sessionId, { tokens = 100 } = {}) {
  const dir = join(home, 'sessions', '2026', '09', '10');
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2026-09-10T10:00:00.000Z',
      payload: { id: sessionId, cwd: '/work/proj', model: 'gpt-5.5' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-09-10T10:01:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: tokens, output_tokens: 10, cached_input_tokens: 0 } },
      },
    },
  ];
  const file = join(dir, `rollout-2026-09-10T10-00-00-${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

async function reimport() {
  vi.resetModules();
  const config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  parseCodex = await import('../../plugin/hooks/codex/parse-codex.mjs');
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-codex-homes-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('CODEX_HOME', '');
  await reimport();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('findCodexSessionFile', () => {
  it('finds a rollout in the default home', async () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    writeRollout(join(homeDir, '.codex'), sid);
    expect(parseCodex.findCodexSessionFile(sid)).toContain(sid);
  });

  it('finds a rollout in the home CODEX_HOME points at', async () => {
    const sid = '22222222-2222-2222-2222-222222222222';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, sid);

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    // Before the fix this returned null, and the caller fell back to an
    // unrelated session in ~/.codex.
    expect(parseCodex.findCodexSessionFile(sid)).toContain('orca-codex-home');
  });

  it('still searches the default home when CODEX_HOME is set', async () => {
    const orcaSid = '33333333-3333-3333-3333-333333333333';
    const defaultSid = '44444444-4444-4444-4444-444444444444';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, orcaSid);
    writeRollout(join(homeDir, '.codex'), defaultSid);

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    expect(parseCodex.findCodexSessionFile(orcaSid)).toContain('orca-codex-home');
    expect(parseCodex.findCodexSessionFile(defaultSid)).toContain('.codex');
  });

  it('returns null rather than guessing when the id is unknown', () => {
    writeRollout(join(homeDir, '.codex'), '55555555-5555-5555-5555-555555555555');
    expect(parseCodex.findCodexSessionFile('99999999-9999-9999-9999-999999999999')).toBeNull();
  });
});

describe('removed fallbacks', () => {
  it('no longer exports the latest-session guessers', () => {
    expect(parseCodex.findLatestCodexSessionFile).toBeUndefined();
    expect(parseCodex.parseLatestCodexSession).toBeUndefined();
  });
});

describe('parseCodexSession', () => {
  it('parses across homes by id', async () => {
    const sid = '66666666-6666-6666-6666-666666666666';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, sid, { tokens: 500 });

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    const parsed = parseCodex.parseCodexSession(sid);
    expect(parsed).toMatchObject({ sessionId: sid, cwd: '/work/proj', model: 'gpt-5.5' });
    expect(parsed.totalTokens).toBe(510);
  });
});
