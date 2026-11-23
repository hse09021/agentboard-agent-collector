/**
 * One event per model, speed and prompt-size tier (#19), through the real
 * hooks.
 *
 * Runs the Claude Code worker and Codex notify as child processes against a
 * stub server and checks what lands there: separate events for a Haiku
 * subagent, a fast-mode response and a long prompt inside one Opus session; a
 * ledger record from before #19 converted without sending anything twice; and
 * a Codex thread that switches model mid-way.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = (rel) => fileURLToPath(new URL(`../../plugin/hooks/${rel}`, import.meta.url));
const WORKER = hookPath('claude/worker.mjs');
const NOTIFY = hookPath('codex/notify.mjs');
const SESSION = 'cccccccc-0000-4000-8000-000000000019';

let root;
let configDir;
let server;
let received;
let env;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-buckets-')));
  configDir = join(root, 'agentboard');
  mkdirSync(configDir, { recursive: true });
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
  const api = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev',
      default_server: { api_base_url: api, app_base_url: api, device_id: 'dev' },
      bindings: [],
    })
  );
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
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const ledger = () => JSON.parse(readFileSync(join(configDir, 'hook-sent.json'), 'utf-8'));
const summary = () =>
  received
    .map((e) => [e.model, e.speed, e.context_size_bucket, e.total_tokens])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// ─── Claude Code ──────────────────────────────────────────────────────────────

const transcriptDir = () => join(root, 'claude', 'projects', 'p');
const transcript = () => join(transcriptDir(), `${SESSION}.jsonl`);

function response(id, model, usage, ts) {
  return {
    type: 'assistant',
    timestamp: ts,
    cwd: root,
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model, stop_reason: 'end_turn', usage: { speed: 'standard', ...usage } },
  };
}

let payloads = 0;
function worker() {
  const payload = join(root, `payload-${++payloads}.json`);
  writeFileSync(payload, JSON.stringify({ session_id: SESSION, transcript_path: transcript(), cwd: root, hook_event_name: 'Stop' }));
  return run(WORKER, [payload]);
}

describe('Claude Code worker', () => {
  beforeEach(() => {
    mkdirSync(join(transcriptDir(), SESSION, 'subagents'), { recursive: true });
    writeFileSync(
      transcript(),
      jsonl([
        response('a', 'claude-opus-5-5', { input_tokens: 1_000, output_tokens: 100 }, '2026-11-20T10:00:00.000Z'),
        response('b', 'claude-opus-5-5', { input_tokens: 2_000, output_tokens: 200, speed: 'fast' }, '2026-11-20T10:01:00.000Z'),
        response('c', 'claude-opus-5-5', { input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 300 }, '2026-11-20T10:02:00.000Z'),
      ])
    );
    writeFileSync(
      join(transcriptDir(), SESSION, 'subagents', 'agent-1.jsonl'),
      jsonl([response('d', 'claude-haiku-5-5', { input_tokens: 400, output_tokens: 40 }, '2026-11-20T10:03:00.000Z')])
    );
  });

  it('sends each model, speed and prompt-size tier as its own event', async () => {
    expect((await worker()).code).toBe(0);
    expect(summary()).toEqual([
      ['claude-haiku-5-5', 'standard', 'up_to_100k', 440],
      ['claude-opus-5-5', 'fast', 'up_to_100k', 2_200],
      ['claude-opus-5-5', 'standard', 'up_to_100k', 1_100],
      ['claude-opus-5-5', 'standard', 'up_to_272k', 150_310],
    ]);
    expect(new Set(received.map((e) => e.event_id)).size).toBe(4);
    expect(received.every((e) => e.session_id === SESSION)).toBe(true);
    expect(Object.keys(ledger()[`claude_code:${SESSION}`].buckets)).toHaveLength(4);

    received.length = 0;
    expect((await worker()).code).toBe(0);
    expect(received).toEqual([]);
  });

  // A collector from before #19 recorded one flat total. It covered the
  // earliest responses, so converting it must send exactly the rest.
  it('converts a flat ledger record without sending anything twice', async () => {
    writeFileSync(
      join(configDir, 'hook-sent.json'),
      JSON.stringify({
        [`claude_code:${SESSION}`]: {
          sentAt: new Date().toISOString(),
          totals: { inputTokens: 3_000, outputTokens: 300, totalTokens: 3_300 },
          counting: 'per-response',
          route: 'default',
        },
      })
    );

    expect((await worker()).code).toBe(0);
    expect(summary()).toEqual([
      ['claude-haiku-5-5', 'standard', 'up_to_100k', 440],
      ['claude-opus-5-5', 'standard', 'up_to_272k', 150_310],
    ]);
    expect(ledger()[`claude_code:${SESSION}`].totals.totalTokens).toBe(3_300 + 440 + 150_310);

    received.length = 0;
    appendFileSync(
      transcript(),
      jsonl([response('e', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5, speed: 'fast' }, '2026-11-20T11:00:00.000Z')])
    );
    expect((await worker()).code).toBe(0);
    expect(summary()).toEqual([['claude-opus-5-5', 'fast', 'up_to_100k', 10]]);
  });
});

// ─── Codex ────────────────────────────────────────────────────────────────────

describe('Codex notify', () => {
  it('sends the calls of each model as their own events', async () => {
    const dir = join(root, 'codex', 'sessions', '2026', '11', '20');
    mkdirSync(dir, { recursive: true });
    const tokenCount = (ts, usage) => ({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'token_count', info: { last_token_usage: usage } },
    });
    writeFileSync(
      join(dir, `rollout-2026-11-20T10-00-00-${SESSION}.jsonl`),
      jsonl([
        { type: 'session_meta', timestamp: '2026-11-20T10:00:00.000Z', payload: { id: SESSION, cwd: root } },
        { type: 'turn_context', timestamp: '2026-11-20T10:00:00.000Z', payload: { model: 'gpt-6.2-sol' } },
        tokenCount('2026-11-20T10:01:00.000Z', { input_tokens: 1_000, output_tokens: 10, cache_write_input_tokens: 7 }),
        { type: 'turn_context', timestamp: '2026-11-20T10:02:00.000Z', payload: { model: 'gpt-6-astra' } },
        tokenCount('2026-11-20T10:03:00.000Z', { input_tokens: 2_000, output_tokens: 20 }),
      ])
    );

    expect((await run(NOTIFY, [JSON.stringify({ 'thread-id': SESSION, status: 'completed' })])).code).toBe(0);
    expect(summary()).toEqual([
      ['gpt-6-astra', 'standard', 'up_to_100k', 2_020],
      ['gpt-6.2-sol', 'standard', 'up_to_100k', 1_010],
    ]);
    expect(received.find((e) => e.model === 'gpt-6.2-sol').cache_write_input_tokens).toBe(7);
  });
});
