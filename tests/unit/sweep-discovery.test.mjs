/**
 * Discovery tests for plugin/hooks/lib/sweep.mjs.
 *
 * Two properties matter here and nothing else really does:
 *
 *   - Claude subagent transcripts must NOT be discovered as standalone
 *     sessions. parseClaudeSession already folds <session>/subagents/*.jsonl
 *     into the parent, so enumerating them separately double-counts every
 *     subagent. The walk is depth-2 and file-only, which excludes them
 *     structurally — a name-based filter would rot the day Claude adds another
 *     sibling directory.
 *   - The Codex walk prunes whole YYYY/MM/DD directories, which is what keeps a
 *     home holding years of rollouts cheap to scan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;

let homeDir;
let sweep;

function touch(file, ageMs = 0) {
  writeFileSync(file, '{}\n');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

function dateDir(root, ageMs) {
  const when = new Date(Date.now() - ageMs);
  return join(
    root,
    String(when.getUTCFullYear()),
    String(when.getUTCMonth() + 1).padStart(2, '0'),
    String(when.getUTCDate()).padStart(2, '0')
  );
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-sweep-discovery-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.resetModules();
  const config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  sweep = await import('../../plugin/hooks/lib/sweep.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('discoverClaudeTranscriptFiles', () => {
  it('takes the session transcript but never its subagents or memory dir', () => {
    const projectDir = join(homeDir, '.claude', 'projects', 'c--work-proj');
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    mkdirSync(join(projectDir, sessionId, 'subagents'), { recursive: true });
    mkdirSync(join(projectDir, 'memory'), { recursive: true });

    touch(join(projectDir, `${sessionId}.jsonl`));
    touch(join(projectDir, sessionId, 'subagents', 'agent-1.jsonl'));
    touch(join(projectDir, sessionId, 'subagents', 'agent-2.jsonl'));
    touch(join(projectDir, 'memory', 'notes.jsonl'));

    const found = sweep.discoverClaudeTranscriptFiles();

    expect(found).toHaveLength(1);
    expect(found[0].sessionIdHint).toBe(sessionId);
    expect(found.some((f) => f.filePath.includes('subagents'))).toBe(false);
    expect(found.some((f) => f.filePath.includes('memory'))).toBe(false);
  });

  it('ignores transcripts older than the discovery horizon', () => {
    const projectDir = join(homeDir, '.claude', 'projects', 'c--work-proj');
    mkdirSync(projectDir, { recursive: true });
    touch(join(projectDir, 'recent.jsonl'), DAY_MS);
    touch(join(projectDir, 'ancient.jsonl'), 200 * DAY_MS);

    const found = sweep.discoverClaudeTranscriptFiles();
    expect(found.map((f) => f.sessionIdHint)).toEqual(['recent']);
  });

  it('returns candidates newest first', () => {
    const projectDir = join(homeDir, '.claude', 'projects', 'c--work-proj');
    mkdirSync(projectDir, { recursive: true });
    touch(join(projectDir, 'older.jsonl'), 5 * DAY_MS);
    touch(join(projectDir, 'newer.jsonl'), 1 * DAY_MS);

    expect(sweep.discoverClaudeTranscriptFiles().map((f) => f.sessionIdHint)).toEqual([
      'newer',
      'older',
    ]);
  });
});

describe('discoverCodexSessionFiles', () => {
  it('extracts the session uuid from the rollout filename', () => {
    const sessions = join(homeDir, '.codex', 'sessions');
    const dir = dateDir(sessions, 0);
    mkdirSync(dir, { recursive: true });
    touch(join(dir, 'rollout-2026-09-10T12-00-00-019fb322-9136-71c3-b651-5467b4aef078.jsonl'));

    const found = sweep.discoverCodexSessionFiles();
    expect(found).toHaveLength(1);
    expect(found[0].sessionIdHint).toBe('019fb322-9136-71c3-b651-5467b4aef078');
  });

  it('prunes date directories outside the horizon', () => {
    const sessions = join(homeDir, '.codex', 'sessions');
    const recent = dateDir(sessions, DAY_MS);
    const ancient = dateDir(sessions, 200 * DAY_MS);
    mkdirSync(recent, { recursive: true });
    mkdirSync(ancient, { recursive: true });
    touch(join(recent, 'rollout-a-11111111-1111-1111-1111-111111111111.jsonl'), DAY_MS);
    touch(join(ancient, 'rollout-b-22222222-2222-2222-2222-222222222222.jsonl'), 200 * DAY_MS);

    const found = sweep.discoverCodexSessionFiles();
    expect(found).toHaveLength(1);
    expect(found[0].sessionIdHint).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('keeps a session started long ago but still being written to', () => {
    // Codex files a rollout under the date the session STARTED and updates it
    // in place on resume, so pruning by directory date alone would hide a
    // long-running session that is active today.
    const sessions = join(homeDir, '.codex', 'sessions');
    const dir = dateDir(sessions, 60 * DAY_MS);
    mkdirSync(dir, { recursive: true });
    touch(join(dir, 'rollout-c-33333333-3333-3333-3333-333333333333.jsonl'), 0);

    expect(sweep.discoverCodexSessionFiles()).toHaveLength(1);
  });

  it('does not descend past YYYY/MM/DD', () => {
    const sessions = join(homeDir, '.codex', 'sessions');
    const deep = join(dateDir(sessions, 0), 'unexpected');
    mkdirSync(deep, { recursive: true });
    touch(join(deep, 'rollout-d-44444444-4444-4444-4444-444444444444.jsonl'));

    expect(sweep.discoverCodexSessionFiles()).toHaveLength(0);
  });

  it('finds rollouts across every registered home', async () => {
    const orcaHome = join(homeDir, 'orca-codex');
    const orcaDir = dateDir(join(orcaHome, 'sessions'), 0);
    const defaultDir = dateDir(join(homeDir, '.codex', 'sessions'), 0);
    mkdirSync(orcaDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    touch(join(orcaDir, 'rollout-e-55555555-5555-5555-5555-555555555555.jsonl'));
    touch(join(defaultDir, 'rollout-f-66666666-6666-6666-6666-666666666666.jsonl'));

    vi.stubEnv('CODEX_HOME', orcaHome);
    vi.resetModules();
    sweep = await import('../../plugin/hooks/lib/sweep.mjs');

    const ids = sweep.discoverCodexSessionFiles().map((f) => f.sessionIdHint);
    expect(ids).toContain('55555555-5555-5555-5555-555555555555');
    expect(ids).toContain('66666666-6666-6666-6666-666666666666');
  });
});

describe('maxFiles', () => {
  it('caps how many candidates one run considers', () => {
    const projectDir = join(homeDir, '.claude', 'projects', 'c--work-proj');
    mkdirSync(projectDir, { recursive: true });
    for (let i = 0; i < 10; i++) touch(join(projectDir, `s${i}.jsonl`));

    expect(sweep.discoverClaudeTranscriptFiles({ maxFiles: 3 })).toHaveLength(3);
  });
});
