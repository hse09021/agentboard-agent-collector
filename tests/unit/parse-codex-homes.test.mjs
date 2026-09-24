/**
 * Multi-home resolution in plugin/hooks/codex/parse-codex.mjs.
 *
 * This is the regression test for the Orca bug: Codex honours CODEX_HOME, and
 * an orchestrator points it at its own runtime home, so a lookup rooted at
 * homedir() finds nothing. It also pins the removal of the "newest rollout
 * anywhere" fallback, which used to hand the caller an unrelated session whose
 * tokens were then diffed against another thread's ledger entry and routed to
 * that thread's server. And it pins that a thread Codex moved onto a new rollout
 * page is read as a whole: the ledger keeps one figure per thread, so reading
 * only the first page left every later turn uncollected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let parseCodex;

function writeRollout(
  home,
  sessionId,
  { tokens = 100, page, metaId = sessionId, day = '10', stamp = '2026-09-10T10-00-00' } = {}
) {
  const dir = join(home, 'sessions', '2026', '09', day);
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: 'session_meta',
      timestamp: `2026-09-${day}T10:00:00.000Z`,
      payload: { id: metaId, cwd: '/work/proj', model: 'gpt-5.5' },
    },
    {
      type: 'event_msg',
      timestamp: `2026-09-${day}T10:01:00.000Z`,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: tokens, output_tokens: 10, cached_input_tokens: 0 } },
      },
    },
  ];
  const name = page ? `${sessionId}_${page}` : sessionId;
  const file = join(dir, `rollout-${stamp}-${name}.jsonl`);
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

describe('findCodexSessionFiles', () => {
  it('finds a rollout in the default home', async () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    writeRollout(join(homeDir, '.codex'), sid);
    expect(parseCodex.findCodexSessionFiles(sid)).toEqual([expect.stringContaining(sid)]);
  });

  it('finds a rollout in the home CODEX_HOME points at', async () => {
    const sid = '22222222-2222-2222-2222-222222222222';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, sid);

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    // Before the fix this returned null, and the caller fell back to an
    // unrelated session in ~/.codex.
    expect(parseCodex.findCodexSessionFiles(sid)).toEqual([expect.stringContaining('orca-codex-home')]);
  });

  it('still searches the default home when CODEX_HOME is set', async () => {
    const orcaSid = '33333333-3333-3333-3333-333333333333';
    const defaultSid = '44444444-4444-4444-4444-444444444444';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, orcaSid);
    writeRollout(join(homeDir, '.codex'), defaultSid);

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    expect(parseCodex.findCodexSessionFiles(orcaSid)).toEqual([expect.stringContaining('orca-codex-home')]);
    expect(parseCodex.findCodexSessionFiles(defaultSid)).toEqual([expect.stringContaining('.codex')]);
  });

  it('returns nothing rather than guessing when the id is unknown', () => {
    writeRollout(join(homeDir, '.codex'), '55555555-5555-5555-5555-555555555555');
    expect(parseCodex.findCodexSessionFiles('99999999-9999-9999-9999-999999999999')).toEqual([]);
  });

  it('finds every page of a thread, oldest first, even across date directories', () => {
    const sid = '77777777-7777-7777-7777-777777777777';
    const page = '77777778-0000-0000-0000-000000000000';
    const home = join(homeDir, '.codex');
    const later = writeRollout(home, sid, { page, day: '11', stamp: '2026-09-11T09-00-00' });
    const first = writeRollout(home, sid);

    expect(parseCodex.findCodexSessionFiles(sid)).toEqual([first, later]);
  });

  it('never treats a page id as a thread of its own', () => {
    const sid = '88888888-8888-8888-8888-888888888888';
    const page = '88888889-0000-0000-0000-000000000000';
    writeRollout(join(homeDir, '.codex'), sid, { page });

    expect(parseCodex.findCodexSessionFiles(page)).toEqual([]);
  });

  it('takes every page from one home, never mixing in a backfilled copy', async () => {
    const sid = '99999999-0000-0000-0000-000000000001';
    const page = '99999999-0000-0000-0000-000000000002';
    const orcaHome = join(homeDir, 'orca-codex-home');
    writeRollout(orcaHome, sid);
    writeRollout(orcaHome, sid, { page, stamp: '2026-09-10T11-00-00' });
    writeRollout(join(homeDir, '.codex'), sid);

    vi.stubEnv('CODEX_HOME', orcaHome);
    await reimport();

    const found = parseCodex.findCodexSessionFiles(sid);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.includes('orca-codex-home'))).toBe(true);
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

  it('adds up a thread across its pages, per day', () => {
    const sid = 'aaaaaaaa-7777-7777-7777-777777777777';
    const page = 'aaaaaaab-0000-0000-0000-000000000000';
    const home = join(homeDir, '.codex');
    writeRollout(home, sid, { tokens: 500 });
    writeRollout(home, sid, { tokens: 200, page, day: '11', stamp: '2026-09-11T09-00-00' });

    const parsed = parseCodex.parseCodexSession(sid);
    expect(parsed.sessionId).toBe(sid);
    expect(parsed.totalTokens).toBe(510 + 210);
    expect(parsed.byDate.map((d) => [d.date, d.totalTokens])).toEqual([
      ['2026-09-10', 510],
      ['2026-09-11', 210],
    ]);
  });

  it('leaves out a file named like a page whose session_meta names another thread', () => {
    const sid = 'bbbbbbbb-7777-7777-7777-777777777777';
    const other = 'bbbbbbbc-0000-0000-0000-000000000000';
    const home = join(homeDir, '.codex');
    writeRollout(home, sid, { tokens: 500 });
    writeRollout(home, sid, { tokens: 900, page: other, metaId: other, stamp: '2026-09-10T11-00-00' });

    expect(parseCodex.parseCodexSession(sid).totalTokens).toBe(510);
  });
});
