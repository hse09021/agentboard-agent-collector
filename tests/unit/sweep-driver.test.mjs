/**
 * Tests for plugin/hooks/lib/sweep.mjs — the cross-agent sweep.
 *
 * The sweep is what makes a sub-agent running a *different* CLI count at all:
 * that CLI may have no agentboard hooks in its own home, so nothing ever fires
 * for it, but the main agent's hook fires every turn and sweeps on its behalf.
 *
 * Because it reaches sessions no hook announced, its limits are the interesting
 * part — most of what follows tests a guardrail, not a feature.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;

let homeDir;
let config;
let sweep;

function okVerdict() {
  return { parsed: true, accepted: 1, duplicates: 0, rejected: 0, reasons: {}, canAdvanceLedger: true };
}

/** Collects every upload so assertions can look at destination and payload. */
function recordingUploader(sink, impl) {
  return async (apiBaseUrl, token, deviceId, events) => {
    sink.push({ apiBaseUrl, token, deviceId, events });
    return impl ? impl(apiBaseUrl, events) : okVerdict();
  };
}

async function bootstrap({ bindings = [], credentials = {} } = {}) {
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  writeFileSync(
    config.CONFIG_PATH,
    JSON.stringify({
      version: 2,
      device_id: 'dev-default',
      default_server: {
        api_base_url: 'https://community.invalid/api',
        app_base_url: 'https://community.invalid',
        device_id: 'dev-default',
      },
      bindings,
    })
  );
  writeFileSync(config.TOKEN_PATH, 'community-token');

  if (Object.keys(credentials).length) {
    mkdirSync(join(config.CONFIG_DIR, 'credentials'), { recursive: true });
    for (const [ref, value] of Object.entries(credentials)) {
      writeFileSync(join(config.CONFIG_DIR, 'credentials', `${ref}.cred`), value);
    }
  }

  sweep = await import('../../plugin/hooks/lib/sweep.mjs');
}

function codexLines(sessionId, cwd, { tokens = 400, ts }) {
  const stamp = ts ?? new Date().toISOString();
  return [
    { type: 'session_meta', timestamp: stamp, payload: { id: sessionId, cwd, model: 'gpt-5.5' } },
    {
      type: 'event_msg',
      timestamp: stamp,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: tokens, output_tokens: 100, cached_input_tokens: 0 } },
      },
    },
  ];
}

/** Writes a codex rollout under <home>/sessions/YYYY/MM/DD/, dated `ageMs` ago. */
function writeCodexSession(homeRoot, sessionId, cwd, { ageMs = 0, tokens = 400 } = {}) {
  const when = new Date(Date.now() - ageMs);
  const dir = join(
    homeRoot,
    'sessions',
    String(when.getUTCFullYear()),
    String(when.getUTCMonth() + 1).padStart(2, '0'),
    String(when.getUTCDate()).padStart(2, '0')
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  const lines = codexLines(sessionId, cwd, { tokens, ts: when.toISOString() });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

function writeClaudeSession(homeRoot, project, sessionId, cwd, { ageMs = 0, tokens = 90 } = {}) {
  const dir = join(homeRoot, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - ageMs).toISOString();
  const line = {
    type: 'assistant',
    timestamp: when,
    cwd,
    requestId: `req_${sessionId}`,
    message: {
      id: `msg_${sessionId}`,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: tokens,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify(line) + '\n');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-sweep-driver-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('AGENTBOARD_SWEEP', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('basic collection', () => {
  it('uploads a recent session no hook ever announced', async () => {
    await bootstrap();
    writeCodexSession(join(homeDir, '.codex'), 'aaaaaaaa-0000-0000-0000-000000000001', '/work/proj');

    const sent = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(report.uploaded).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].events[0]).toMatchObject({
      source: 'codex',
      session_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      model: 'gpt-5.5',
    });
  });

  it('is a no-op on the second run', async () => {
    await bootstrap();
    writeCodexSession(join(homeDir, '.codex'), 'aaaaaaaa-0000-0000-0000-000000000001', '/work/proj');

    const first = [];
    await sweep.runSweep({ uploader: recordingUploader(first) });
    const second = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(second) });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(report.uploaded).toBe(0);
  });

  it('collects Claude sessions too, and reads cwd from the transcript', async () => {
    await bootstrap();
    writeClaudeSession(join(homeDir, '.claude'), 'c--work-proj', 'bbbbbbbb-0000-0000-0000-000000000002', '/work/proj');

    const sent = [];
    await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(sent).toHaveLength(1);
    expect(sent[0].events[0]).toMatchObject({
      source: 'claude_code',
      session_id: 'bbbbbbbb-0000-0000-0000-000000000002',
    });
  });
});

describe('guardrail 2 — no retroactive flood', () => {
  it('seeds a session older than the cutoff instead of uploading it', async () => {
    await bootstrap();
    writeCodexSession(join(homeDir, '.codex'), 'cccccccc-0000-0000-0000-000000000003', '/work/proj', {
      ageMs: 10 * DAY_MS,
    });

    const sent = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(sent).toHaveLength(0);
    expect(report.seeded).toBe(1);
    // Recorded as known, so its history can never be mistaken for new tokens.
    expect(config.getSentTotals('codex', 'cccccccc-0000-0000-0000-000000000003').totalTokens).toBeGreaterThan(0);
  });

  it('leaves a seeded session unrouted, so it is still free to route by cwd', async () => {
    await bootstrap();
    writeCodexSession(join(homeDir, '.codex'), 'cccccccc-0000-0000-0000-000000000003', '/work/proj', {
      ageMs: 10 * DAY_MS,
    });
    await sweep.runSweep({ uploader: recordingUploader([]) });

    // Reporting a route here would pin the session to the community server for
    // good — including a session inside a directory connected to an org.
    expect(config.getSentRoute('codex', 'cccccccc-0000-0000-0000-000000000003')).toBeNull();
  });

  it('uploads only what accrues after a seed, never the seeded history', async () => {
    await bootstrap();
    const home = join(homeDir, '.codex');
    const sid = 'cccccccc-0000-0000-0000-000000000003';
    const file = writeCodexSession(home, sid, '/work/proj', { ageMs: 10 * DAY_MS, tokens: 5000 });
    await sweep.runSweep({ uploader: recordingUploader([]) });

    // The session resumes today: same file, more turns, fresh mtime.
    const extra = {
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 70, output_tokens: 30, cached_input_tokens: 0 } },
      },
    };
    writeFileSync(file, readFileSync(file, 'utf-8') + JSON.stringify(extra) + '\n');

    const sent = [];
    await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(sent).toHaveLength(1);
    expect(sent[0].events[0].total_tokens).toBe(100);
  });
});

describe('guardrail 4 — per-session routing', () => {
  const orgBinding = {
    abs_dir: '/work/org',
    real_dir: '/work/org',
    credential_ref: 'org-a',
    server: {
      api_base_url: 'https://org-a.invalid/api',
      app_base_url: 'https://org-a.invalid',
      device_id: 'dev-org-a',
    },
  };

  it('sends each session to the server its own cwd resolves to', async () => {
    await bootstrap({ bindings: [orgBinding], credentials: { 'org-a': 'org-token' } });
    const home = join(homeDir, '.codex');
    writeCodexSession(home, 'dddddddd-0000-0000-0000-000000000004', '/work/org/api');
    writeCodexSession(home, 'eeeeeeee-0000-0000-0000-000000000005', '/work/personal');

    const sent = [];
    await sweep.runSweep({ uploader: recordingUploader(sent) });

    const byApi = Object.fromEntries(sent.map((s) => [s.events[0].session_id, s.apiBaseUrl]));
    expect(byApi['dddddddd-0000-0000-0000-000000000004']).toBe('https://org-a.invalid/api');
    expect(byApi['eeeeeeee-0000-0000-0000-000000000005']).toBe('https://community.invalid/api');
  });

  it('skips a session whose route has no credential rather than falling back', async () => {
    // No credential file for org-a: the only safe answer is to send nothing.
    await bootstrap({ bindings: [orgBinding] });
    writeCodexSession(join(homeDir, '.codex'), 'dddddddd-0000-0000-0000-000000000004', '/work/org/api');

    const sent = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(sent).toHaveLength(0);
    expect(report.skipped.nocred).toBe(1);
    expect(config.getSentTotals('codex', 'dddddddd-0000-0000-0000-000000000004').totalTokens).toBe(0);
  });

  it('never lets one session inherit another session pin', async () => {
    await bootstrap({ bindings: [orgBinding], credentials: { 'org-a': 'org-token' } });
    const home = join(homeDir, '.codex');
    // Pin the org session first, exactly as a prior upload would have.
    config.markTotalsSent('codex', 'dddddddd-0000-0000-0000-000000000004', { totalTokens: 1 }, 'org-a');
    writeCodexSession(home, 'dddddddd-0000-0000-0000-000000000004', '/work/org/api');
    writeCodexSession(home, 'eeeeeeee-0000-0000-0000-000000000005', '/work/personal');

    const sent = [];
    await sweep.runSweep({ uploader: recordingUploader(sent) });

    const personal = sent.find((s) => s.events[0].session_id === 'eeeeeeee-0000-0000-0000-000000000005');
    expect(personal.apiBaseUrl).toBe('https://community.invalid/api');
  });
});

describe('duplicate homes', () => {
  it('uploads once when an orchestrator keeps a backfilled copy of a session', async () => {
    await bootstrap();
    const sid = 'ffffffff-0000-0000-0000-000000000006';
    const liveHome = join(homeDir, 'orca-codex');
    mkdirSync(liveHome, { recursive: true });

    // The live copy has more tokens; the backfilled copy is an older snapshot.
    writeCodexSession(liveHome, sid, '/work/proj', { tokens: 900 });
    writeCodexSession(join(homeDir, '.codex'), sid, '/work/proj', { ageMs: 60_000, tokens: 300 });

    vi.stubEnv('CODEX_HOME', liveHome);
    await bootstrap();

    const sent = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(report.uploaded).toBe(1);
    expect(sent).toHaveLength(1);
    // The stale copy must not drag the ledger backwards; if it did, the next
    // run would re-upload the difference as a fresh delta.
    const after = config.getSentTotals('codex', sid).totalTokens;
    const second = [];
    await sweep.runSweep({ uploader: recordingUploader(second) });
    expect(second).toHaveLength(0);
    expect(config.getSentTotals('codex', sid).totalTokens).toBe(after);
  });
});

describe('concurrency and failure', () => {
  it('skips a session another hook is already uploading', async () => {
    await bootstrap();
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
    writeCodexSession(join(homeDir, '.codex'), sid, '/work/proj');
    expect(config.acquireSessionLock('codex', sid)).toBe(true);

    const sent = [];
    const report = await sweep.runSweep({ uploader: recordingUploader(sent) });

    expect(sent).toHaveLength(0);
    expect(report.skipped.locked).toBe(1);
  });

  it('keeps going when one session fails to upload, and does not advance its ledger', async () => {
    await bootstrap();
    const home = join(homeDir, '.codex');
    const bad = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const good = 'bbbbbbbb-0000-0000-0000-00000000000b';
    writeCodexSession(home, bad, '/work/bad');
    writeCodexSession(home, good, '/work/good');

    const sent = [];
    const report = await sweep.runSweep({
      uploader: recordingUploader(sent, (_api, events) => {
        if (events[0].session_id === bad) throw new Error('network down');
        return okVerdict();
      }),
    });

    expect(report.errors).toBe(1);
    expect(report.uploaded).toBe(1);
    expect(config.getSentTotals('codex', bad).totalTokens).toBe(0);
    expect(config.getSentTotals('codex', good).totalTokens).toBeGreaterThan(0);
  });

  it('does not advance the ledger when the server rejects retriably', async () => {
    await bootstrap();
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
    writeCodexSession(join(homeDir, '.codex'), sid, '/work/proj');

    const report = await sweep.runSweep({
      uploader: async () => ({ parsed: true, canAdvanceLedger: false }),
    });

    expect(report.uploaded).toBe(0);
    expect(config.getSentTotals('codex', sid).totalTokens).toBe(0);
  });
});

describe('bounds', () => {
  it('stops when the budget is spent and commits what it finished', async () => {
    await bootstrap();
    const home = join(homeDir, '.codex');
    for (let i = 0; i < 5; i++) {
      writeCodexSession(home, `aaaaaaaa-0000-0000-0000-00000000000${i}`, '/work/proj');
    }

    const sent = [];
    const report = await sweep.runSweep({ budgetMs: -1, uploader: recordingUploader(sent) });

    expect(report.timedOut).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('respects the per-run upload cap', async () => {
    await bootstrap();
    const home = join(homeDir, '.codex');
    for (let i = 0; i < 4; i++) {
      writeCodexSession(home, `aaaaaaaa-0000-0000-0000-00000000000${i}`, '/work/proj');
    }

    const sent = [];
    const report = await sweep.runSweep({ maxUploads: 2, uploader: recordingUploader(sent) });

    expect(report.uploaded).toBe(2);
    expect(sent).toHaveLength(2);
  });
});

describe('enablement', () => {
  it('honours config.sweep, the env override, and the recursion guard', async () => {
    await bootstrap();
    expect(sweep.isSweepEnabled({ sweep: 'registered' }, {})).toBe(true);
    expect(sweep.isSweepEnabled({}, {})).toBe(true);
    expect(sweep.isSweepEnabled({ sweep: 'off' }, {})).toBe(false);
    expect(sweep.isSweepEnabled({ sweep: 'registered' }, { AGENTBOARD_SWEEP: 'off' })).toBe(false);
    expect(sweep.isSweepEnabled({ sweep: 'registered' }, { AGENTBOARD_INTERNAL: '1' })).toBe(false);
    expect(sweep.isSweepEnabled(null, {})).toBe(false);
  });
});
