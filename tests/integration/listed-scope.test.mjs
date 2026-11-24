/**
 * "listed" collection scope (#23), through the real hooks.
 *
 * Runs the Claude Code worker and Codex notify as child processes, and the
 * sweep in-process, against a stub server, walking one session through the
 * scope's life: untracked (nothing sent), tracked (only what came after it was
 * added), untracked again (stops at once), and back to "all" (nothing withheld
 * is ever sent).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = (rel) => fileURLToPath(new URL(`../../plugin/hooks/${rel}`, import.meta.url));
const WORKER = hookPath('claude/worker.mjs');
const NOTIFY = hookPath('codex/notify.mjs');
const SESSION = 'dddddddd-0000-4000-8000-000000000023';

const at = (hours) => new Date(Date.UTC(2026, 10, 24, 10) + hours * 3_600_000).toISOString();
// Turn n uses n * 1000 input tokens and 100 output tokens.
const tokensOf = (...turns) => turns.reduce((n, t) => n + t * 1_000 + 100, 0);

let root;
let configDir;
let project;
let server;
let received;
let env;

function writeConfig(scope, tracked = []) {
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev',
      default_server: { api_base_url: server.url, app_base_url: server.url, device_id: 'dev' },
      bindings: [],
      default_scope: scope,
      tracked_dirs: tracked.map(([dir, addedAt]) => ({ abs_dir: dir, real_dir: dir, added_at: addedAt })),
    })
  );
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-listed-')));
  configDir = join(root, 'agentboard');
  project = join(root, 'work', 'side-project');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  received = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const events = (raw ? JSON.parse(raw) : {}).events ?? [];
      received.push(...events);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(configDir, '.token'), JSON.stringify({ v: 2, access: 't', access_expires_at: 9_999_999_999 }));

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
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => resolve({ code }));
  });
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const uploaded = () => received.reduce((n, e) => n + e.total_tokens, 0);

// ─── Drivers ──────────────────────────────────────────────────────────────────

const drivers = {
  'Claude Code worker': () => {
    const dir = join(root, 'claude', 'projects', 'p');
    const transcript = join(dir, `${SESSION}.jsonl`);
    mkdirSync(dir, { recursive: true });
    let payloads = 0;
    return {
      add: (n, hours) =>
        appendFileSync(
          transcript,
          jsonl([
            {
              type: 'assistant',
              timestamp: at(hours),
              cwd: project,
              requestId: `req_${n}`,
              message: {
                id: `msg_${n}`,
                model: 'claude-opus-5-5',
                stop_reason: 'end_turn',
                usage: { input_tokens: n * 1_000, output_tokens: 100, speed: 'standard' },
              },
            },
          ])
        ),
      upload: () => {
        const payload = join(root, `payload-${++payloads}.json`);
        writeFileSync(payload, JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }));
        return run(WORKER, [payload]);
      },
    };
  },

  'Codex notify': () => {
    const dir = join(root, 'codex', 'sessions', '2026', '11', '24');
    const rollout = join(dir, `rollout-2026-11-24T10-00-00-${SESSION}.jsonl`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      rollout,
      jsonl([
        { type: 'session_meta', timestamp: at(0), payload: { id: SESSION, cwd: project } },
        { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-6.2-sol' } },
      ])
    );
    return {
      add: (n, hours) =>
        appendFileSync(
          rollout,
          jsonl([
            {
              type: 'event_msg',
              timestamp: at(hours),
              payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n * 1_000, output_tokens: 100 } } },
            },
          ])
        ),
      upload: () => run(NOTIFY, [JSON.stringify({ 'thread-id': SESSION, status: 'completed' })]),
    };
  },

  sweep: () => {
    const base = drivers['Claude Code worker']();
    const transcript = join(root, 'claude', 'projects', 'p', `${SESSION}.jsonl`);
    return {
      add: base.add,
      upload: async () => {
        vi.resetModules();
        const { sweepOneSession } = await import('../../plugin/hooks/lib/sweep.mjs');
        const result = await sweepOneSession({
          source: 'claude_code',
          filePath: transcript,
          sessionIdHint: SESSION,
          mtimeMs: Date.now(),
          size: statSync(transcript).size,
        });
        return { code: result.status === 'error' ? 1 : 0, result };
      },
    };
  },
};

describe.each(Object.keys(drivers))('%s', (name) => {
  it('sends only what a tracked directory used while it was tracked', async () => {
    const d = drivers[name]();

    // Listed, nothing tracked: nothing is sent.
    writeConfig('listed');
    d.add(1, 0);
    expect((await d.upload()).code).toBe(0);
    expect(received).toEqual([]);

    // Tracked from hour 1.5: turn 2 (hour 1) is from before, turn 3 is after.
    writeConfig('listed', [[project, at(1.5)]]);
    d.add(2, 1);
    d.add(3, 2);
    expect((await d.upload()).code).toBe(0);
    expect(uploaded()).toBe(tokensOf(3));
    expect(received.every((e) => e.started_at >= at(1.5))).toBe(true);

    // Untracked: stops at once, including what is not yet sent.
    received.length = 0;
    writeConfig('listed');
    d.add(4, 3);
    expect((await d.upload()).code).toBe(0);
    expect(received).toEqual([]);

    // Back to all: collection resumes, but nothing withheld is sent.
    writeConfig('all');
    d.add(5, 4);
    expect((await d.upload()).code).toBe(0);
    expect(uploaded()).toBe(tokensOf(5));
  });

  // The default: a config without a scope behaves exactly as before #23.
  it('sends everything in all scope, the default', async () => {
    const d = drivers[name]();
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        version: 2,
        device_id: 'dev',
        default_server: { api_base_url: server.url, app_base_url: server.url, device_id: 'dev' },
        bindings: [],
      })
    );
    d.add(1, 0);
    d.add(2, 1);
    expect((await d.upload()).code).toBe(0);
    expect(uploaded()).toBe(tokensOf(1, 2));
  });
});

it('records withheld tokens without pinning a session that never uploaded', async () => {
  const d = drivers['Claude Code worker']();
  writeConfig('listed');
  d.add(1, 0);
  await d.upload();
  const record = JSON.parse(readFileSync(join(configDir, 'hook-sent.json'), 'utf-8'))[`claude_code:${SESSION}`];
  expect(record).toMatchObject({ seeded: true, totals: { totalTokens: tokensOf(1) } });
  expect(record.route).toBeUndefined();
});
