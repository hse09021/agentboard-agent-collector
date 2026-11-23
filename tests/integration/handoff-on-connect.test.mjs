/**
 * A session already running when its directory is connected (#17).
 *
 * Before the fix, a session that had uploaded once to the community server was
 * pinned there for good: everything it did in the newly connected directory
 * kept going to the community server. Now it is handed off at `connected_at`:
 * tokens from before the connection stay with the community server, tokens
 * after go to the organization's, and the organization never sees anything
 * from before.
 *
 * Every upload path runs for real against two stub servers — the Claude Code
 * worker, Codex notify, SessionEnd and SubagentStop as child processes, the
 * sweep in-process — through the same three scenarios:
 *
 *   - the hand-off itself, and the uploads after it
 *   - the organization's upload failing, then retried
 *   - no organization credential
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = (rel) => fileURLToPath(new URL(`../../plugin/hooks/${rel}`, import.meta.url));
const WORKER = hookPath('claude/worker.mjs');
const NOTIFY = hookPath('codex/notify.mjs');
const SESSION_END = hookPath('codex/session-end.mjs');
const SUBAGENT_STOP = hookPath('codex/subagent-stop.mjs');

const REF = 'acme000000000001';
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000017';
const AGENT = 'bbbbbbbb-0000-4000-8000-000000000017';

// Turn 1 is uploaded before the connection. Turn 2 also happens before it but
// is not uploaded yet — the "pre-connect tail". Turns 3 and 4 come after.
const at = (hours) => new Date(Date.UTC(2026, 10, 20, 10) + hours * 3_600_000).toISOString();
const CONNECTED_AT = at(1.5);
const TURNS = {
  1: { ts: at(0), input: 1_000 },
  2: { ts: at(1), input: 2_000 },
  3: { ts: at(2), input: 4_000 },
  4: { ts: at(3), input: 8_000 },
};
const total = (...turns) => turns.reduce((n, t) => n + TURNS[t].input + 100, 0);

function startStub(name) {
  const stub = { name, events: [], attempts: [], failNext: false };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, payload) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      if (req.method !== 'POST' || req.url !== '/v1/events/usage/batch') return send(404, { error: 'not found' });

      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const events = (raw ? JSON.parse(raw) : {}).events ?? [];
      stub.attempts.push(...events.map((e) => ({ ...e, bearer })));
      if (stub.failNext) {
        stub.failNext = false;
        return send(400, { error: 'stub failure' });
      }
      stub.events.push(...events.map((e) => ({ ...e, bearer })));
      return send(200, { accepted: events.length, duplicates: 0, rejected: 0 });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      stub.url = `http://127.0.0.1:${server.address().port}`;
      stub.close = () => new Promise((r) => server.close(() => r()));
      stub.tokens = () => stub.events.reduce((n, e) => n + e.total_tokens, 0);
      resolve(stub);
    });
  });
}

let root;
let configDir;
let project;
let community;
let org;
let env;

function writeConfig(bindings) {
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev_community',
      default_server: { api_base_url: community.url, app_base_url: community.url, device_id: 'dev_community' },
      bindings,
    })
  );
}

const credPath = () => join(configDir, 'credentials', `${REF}.cred`);

function writeOrgCredential() {
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    credPath(),
    JSON.stringify({ v: 2, access: 'org-access', access_expires_at: 9_999_999_999, refresh: 'org-refresh' }),
    { mode: 0o600 }
  );
}

function connect() {
  writeConfig([
    {
      abs_dir: project,
      real_dir: project,
      credential_ref: REF,
      project_label: 'acme-api',
      connected_at: CONNECTED_AT,
      server: { api_base_url: org.url, app_base_url: org.url, label: 'Acme', device_id: 'dev_org' },
    },
  ]);
}

function ledger() {
  try {
    return JSON.parse(readFileSync(join(configDir, 'hook-sent.json'), 'utf-8'));
  } catch {
    return {};
  }
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-handoff-')));
  configDir = join(root, 'agentboard');
  project = join(root, 'work', 'acme-api');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  [community, org] = await Promise.all([startStub('community'), startStub('org')]);

  writeConfig([]);
  writeFileSync(
    join(configDir, '.token'),
    JSON.stringify({ v: 2, access: 'community-access', access_expires_at: 9_999_999_999 }),
    { mode: 0o600 }
  );
  writeOrgCredential();

  env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData'),
    AGENTBOARD_CONFIG_DIR: configDir,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTBOARD_SWEEP: 'off',
    AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE: '0',
  };
  delete env.AGENTBOARD_INTERNAL;
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([community.close(), org.close()]);
  rmSync(root, { recursive: true, force: true });
});

function run(script, { args = [], stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

// ─── Transcripts ──────────────────────────────────────────────────────────────

function claudeLine(n) {
  const { ts, input } = TURNS[n];
  return {
    type: 'assistant',
    timestamp: ts,
    cwd: project,
    requestId: `req_${n}`,
    message: {
      id: `msg_${n}`,
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: input, output_tokens: 100 },
    },
  };
}

function codexLines(id, turns, { meta = true } = {}) {
  const lines = meta
    ? [{ type: 'session_meta', timestamp: TURNS[turns[0]].ts, payload: { id, cwd: project, model: 'gpt-6.2-sol' } }]
    : [];
  for (const n of turns) {
    lines.push({
      type: 'event_msg',
      timestamp: TURNS[n].ts,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: TURNS[n].input, output_tokens: 100, cached_input_tokens: 0 } },
      },
    });
  }
  return lines;
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

function rolloutPath(id) {
  const dir = join(root, 'codex', 'sessions', '2026', '11', '20');
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-11-20T10-00-00-${id}.jsonl`);
}

/**
 * One upload path. `add(turns)` writes those turns to the session; `upload()`
 * runs the path once; `pin()` uploads turn 1 before the connection.
 */
const drivers = {
  'Claude Code worker': () => {
    const transcript = join(root, 'claude', 'projects', 'acme-api', `${SESSION}.jsonl`);
    mkdirSync(join(root, 'claude', 'projects', 'acme-api'), { recursive: true });
    let payloads = 0;
    const upload = () => {
      const payloadFile = join(root, `payload-${++payloads}.json`);
      writeFileSync(
        payloadFile,
        JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: project, hook_event_name: 'Stop' })
      );
      return run(WORKER, { args: [payloadFile] });
    };
    const add = (turns) => appendFileSync(transcript, jsonl(turns.map(claudeLine)));
    return { key: `claude_code:${SESSION}`, add, upload, pin: () => (add([1]), upload()) };
  },

  'Codex notify': () => {
    const rollout = rolloutPath(SESSION);
    let written = false;
    const add = (turns) => {
      appendFileSync(rollout, jsonl(codexLines(SESSION, turns, { meta: !written })));
      written = true;
    };
    const upload = () => run(NOTIFY, { args: [JSON.stringify({ 'thread-id': SESSION, status: 'completed' })] });
    return { key: `codex:${SESSION}`, add, upload, pin: () => (add([1]), upload()) };
  },

  'Codex SessionEnd': () => {
    const rollout = rolloutPath(SESSION);
    let written = false;
    const add = (turns) => {
      appendFileSync(rollout, jsonl(codexLines(SESSION, turns, { meta: !written })));
      written = true;
    };
    // SessionEnd only sweeps a session notify has already reported, so the
    // pre-connect upload goes through notify.
    const pin = () => {
      add([1]);
      return run(NOTIFY, { args: [JSON.stringify({ 'thread-id': SESSION, status: 'completed' })] });
    };
    const upload = () => run(SESSION_END, { stdin: JSON.stringify({ session_id: SESSION, cwd: project }) });
    return { key: `codex:${SESSION}`, add, upload, pin };
  },

  'Codex SubagentStop': () => {
    // The subagent's own ledger entry, routed by its parent's pin.
    const parent = rolloutPath(SESSION);
    const child = rolloutPath(AGENT);
    let written = false;
    const add = (turns) => {
      appendFileSync(child, jsonl(codexLines(AGENT, turns, { meta: !written })));
      written = true;
    };
    const upload = () =>
      run(SUBAGENT_STOP, {
        stdin: JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_transcript_path: child, cwd: project }),
      });
    const pin = async () => {
      writeFileSync(parent, jsonl(codexLines(SESSION, [1])));
      await run(NOTIFY, { args: [JSON.stringify({ 'thread-id': SESSION, status: 'completed' })] });
      community.events.length = 0; // the parent's own turn is not under test
      add([1]);
      return upload();
    };
    return { key: `codex:sub:${AGENT}`, add, upload, pin };
  },

  sweep: () => {
    const transcript = join(root, 'claude', 'projects', 'acme-api', `${SESSION}.jsonl`);
    mkdirSync(join(root, 'claude', 'projects', 'acme-api'), { recursive: true });
    const add = (turns) => appendFileSync(transcript, jsonl(turns.map(claudeLine)));
    const upload = async () => {
      vi.resetModules();
      const { sweepOneSession } = await import('../../plugin/hooks/lib/sweep.mjs');
      const stat = statSync(transcript);
      try {
        const result = await sweepOneSession({
          source: 'claude_code',
          filePath: transcript,
          sessionIdHint: SESSION,
          mtimeMs: Date.now(),
          size: stat.size,
        });
        return { code: result.status === 'error' ? 1 : 0, result };
      } catch (err) {
        return { code: 1, error: err };
      }
    };
    return { key: `claude_code:${SESSION}`, add, upload, pin: () => (add([1]), upload()) };
  },
};

describe.each(Object.keys(drivers))('%s', (name) => {
  it('hands the session off: the pre-connect tail to the community, the rest to the organization', async () => {
    const d = drivers[name]();
    expect((await d.pin()).code).toBe(0);
    expect(community.tokens()).toBe(total(1));
    expect(ledger()[d.key].route).toBe('default');

    connect();
    d.add([2, 3]);
    community.events.length = 0;
    expect((await d.upload()).code).toBe(0);

    expect(community.tokens()).toBe(total(2));
    expect(community.events.every((e) => e.ended_at < CONNECTED_AT)).toBe(true);
    expect(community.events.every((e) => e.bearer === 'community-access')).toBe(true);

    expect(org.tokens()).toBe(total(3));
    // Nothing from before the connection reaches the organization.
    expect(org.events.every((e) => e.started_at >= CONNECTED_AT)).toBe(true);
    expect(org.events.every((e) => e.bearer === 'org-access' && e.device_id === 'dev_org')).toBe(true);
    expect(ledger()[d.key]).toMatchObject({ route: REF, totals: { totalTokens: total(1, 2, 3) } });

    // From now on the session belongs to the organization.
    community.events.length = 0;
    org.events.length = 0;
    d.add([4]);
    expect((await d.upload()).code).toBe(0);
    expect(community.events).toEqual([]);
    expect(org.tokens()).toBe(total(4));
  });

  it('retries only the organization side after its upload fails, with the same event ids', async () => {
    const d = drivers[name]();
    await d.pin();
    connect();
    d.add([2, 3]);
    community.events.length = 0;

    org.failNext = true;
    expect((await d.upload()).code).not.toBe(0);
    expect(community.tokens()).toBe(total(2));
    expect(org.events).toEqual([]);
    const failedIds = org.attempts.map((e) => e.event_id);
    expect(failedIds.length).toBeGreaterThan(0);
    // The tail is recorded on the community route; the rest is still owed.
    expect(ledger()[d.key]).toMatchObject({ route: 'default', totals: { totalTokens: total(1, 2) } });

    community.events.length = 0;
    expect((await d.upload()).code).toBe(0);
    expect(community.events).toEqual([]);
    expect(org.tokens()).toBe(total(3));
    expect(org.events.map((e) => e.event_id)).toEqual(failedIds);
  });

  it('never falls back to the community server without an organization credential', async () => {
    const d = drivers[name]();
    await d.pin();
    connect();
    unlinkSync(credPath());
    d.add([2, 3]);
    community.events.length = 0;

    expect((await d.upload()).code).toBe(0);
    expect(community.tokens()).toBe(total(2));
    expect(org.attempts).toEqual([]);
    expect(ledger()[d.key]).toMatchObject({ route: 'default', totals: { totalTokens: total(1, 2) } });

    // Still owed, and recovered once the credential is back.
    community.events.length = 0;
    expect((await d.upload()).code).toBe(0);
    expect(community.events).toEqual([]);

    writeOrgCredential();
    expect((await d.upload()).code).toBe(0);
    expect(community.events).toEqual([]);
    expect(org.tokens()).toBe(total(3));
  });
});
