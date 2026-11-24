/**
 * The turn's last response, written after Stop fires (#25).
 *
 * Claude Code writes the transcript asynchronously, so Stop can fire before
 * the response that ended the turn is on disk. Runs the real Claude Code
 * worker as a child process against a stub server, and writes that response
 * only once the worker has looked for it and not found it: the Stop upload
 * must still carry it, rather than leaving it for the next hook (`/exit`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../../plugin/hooks/claude/worker.mjs', import.meta.url));
const SESSION = 'eeeeeeee-0000-4000-8000-000000000025';

let root;
let project;
let transcript;
let hookLog;
let server;
let received;
let env;
let payloads;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-flush-')));
  const configDir = join(root, 'agentboard');
  project = join(root, 'work', 'app');
  const transcriptDir = join(root, 'claude', 'projects', 'app');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  transcript = join(transcriptDir, `${SESSION}.jsonl`);
  hookLog = join(root, 'AppData', 'agentboard', 'hook-debug.log');
  received = [];
  payloads = 0;

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
  const url = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev',
      default_server: { api_base_url: url, app_base_url: url, device_id: 'dev' },
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

// ─── Transcript lines ─────────────────────────────────────────────────────────

const at = (seconds) => new Date(Date.UTC(2026, 10, 24, 4, 45) + seconds * 1000).toISOString();

const prompt = (id, seconds) => ({
  type: 'user',
  promptId: id,
  timestamp: at(seconds),
  cwd: project,
  message: { role: 'user', content: 'question' },
});

const toolResult = (id, seconds) => ({
  type: 'user',
  promptId: id,
  timestamp: at(seconds),
  cwd: project,
  toolUseResult: { stdout: '' },
  message: { role: 'user', content: [{ type: 'tool_result', content: '' }] },
});

// Response n uses n * 1000 input tokens and 100 output tokens.
const response = (n, stopReason, seconds) => ({
  type: 'assistant',
  timestamp: at(seconds),
  cwd: project,
  requestId: `req_${n}`,
  message: {
    id: `msg_${n}`,
    model: 'claude-opus-5-5',
    stop_reason: stopReason,
    content: [{ type: stopReason === 'tool_use' ? 'tool_use' : 'text' }],
    usage: { input_tokens: n * 1_000, output_tokens: 100, speed: 'standard' },
  },
});

const tokensOf = (...ns) => ns.reduce((sum, n) => sum + n * 1_000 + 100, 0);
const uploaded = () => received.reduce((sum, e) => sum + e.total_tokens, 0);
const write = (...lines) => appendFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const log = () => (existsSync(hookLog) ? readFileSync(hookLog, 'utf-8') : '');

// ─── Driver ───────────────────────────────────────────────────────────────────

function startWorker(hookEventName) {
  const payload = join(root, `payload-${++payloads}.json`);
  writeFileSync(
    payload,
    JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: project, hook_event_name: hookEventName })
  );
  const child = spawn(process.execPath, [WORKER, payload], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => child.on('close', (code) => resolve(code)));
}

// Resolves once the worker has logged its n-th wait: it has read the
// transcript and found the turn's last response missing. Gives up well within
// the test timeout, so a failing test cannot write into the next one's files.
async function workerIsWaiting(n = 1) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (log().split('waiting for the final response').length > n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('worker never waited for the final response');
}

describe('Stop and the turn\'s last response', { timeout: 15_000 }, () => {
  it('sends the last response even when it is written after Stop fired', async () => {
    write(prompt('p1', 0), response(1, 'tool_use', 1), toolResult('p1', 2));

    const done = startWorker('Stop');
    await workerIsWaiting();
    write(response(2, 'end_turn', 3));
    expect(await done).toBe(0);

    expect(uploaded()).toBe(tokensOf(1, 2));
    expect(log()).toMatch(/final response reached the transcript after \d+ms/);

    // `/exit` after the turn: nothing is left to send.
    expect(await startWorker('SessionEnd')).toBe(0);
    expect(uploaded()).toBe(tokensOf(1, 2));
  });

  // The previous turn's answer is already on disk and must not pass for this
  // turn's.
  it('waits for a turn answered in a single response', async () => {
    write(prompt('p1', 0), response(1, 'end_turn', 1));
    expect(await startWorker('Stop')).toBe(0);
    expect(uploaded()).toBe(tokensOf(1));

    write(prompt('p2', 10));
    const done = startWorker('Stop');
    await workerIsWaiting();
    write(response(2, 'end_turn', 11));
    expect(await done).toBe(0);

    expect(uploaded()).toBe(tokensOf(1, 2));
  });

  // Nothing is lost when the response never shows up in time: what is there is
  // sent, and the next hook sends the rest, as before #25.
  it('gives up after the limit and leaves the rest to the next hook', async () => {
    write(prompt('p1', 0), response(1, 'tool_use', 1), toolResult('p1', 2));

    expect(await startWorker('Stop')).toBe(0);
    expect(uploaded()).toBe(tokensOf(1));
    expect(log()).toMatch(/final response not in the transcript after \d+ms/);

    write(response(2, 'end_turn', 3));
    expect(await startWorker('SessionEnd')).toBe(0);
    expect(uploaded()).toBe(tokensOf(1, 2));
  });

  it('does not wait on SessionEnd', async () => {
    write(prompt('p1', 0), response(1, 'tool_use', 1), toolResult('p1', 2));

    expect(await startWorker('SessionEnd')).toBe(0);
    expect(uploaded()).toBe(tokensOf(1));
    expect(log()).not.toMatch(/waiting for the final response/);
  });
});
