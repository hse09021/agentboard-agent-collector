/**
 * Codex notify across rollout pages.
 *
 * Codex can move a live thread onto a new rollout, `<thread>_<page>.jsonl`,
 * whose session_meta still names the thread, and keeps sending notify with the
 * thread id. notify used to resolve the thread to its first file only, so once
 * the thread moved, every later turn parsed an unchanged file and uploaded
 * nothing.
 *
 * Runs the real hook as a child process against a local server, with the
 * config dir, Codex home, sweep and rate-limit capture all isolated or off.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTIFY = fileURLToPath(new URL('../../plugin/hooks/codex/notify.mjs', import.meta.url));
const THREAD = 'cdcdcdcd-0000-0000-0000-000000000001';
const PAGE = 'cdcdcdce-0000-0000-0000-000000000000';

let root;
let server;
let received;
let env;

function writeRollout(name, tokens, stamp) {
  const dir = join(root, 'codex', 'sessions', '2026', '09', '10');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', timestamp: stamp, payload: { id: THREAD, cwd: root, model: 'gpt-5.5' } },
    {
      type: 'event_msg',
      timestamp: stamp,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: tokens, output_tokens: 100, cached_input_tokens: 0 } },
      },
    },
  ];
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function notify() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOTIFY, JSON.stringify({ 'thread-id': THREAD, status: 'completed' })], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const uploadedTokens = () => received.reduce((n, e) => n + e.total_tokens, 0);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentboard-notify-pages-'));
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { events = [] } = body ? JSON.parse(body) : {};
      received.push(...events);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;

  const configDir = join(root, 'agentboard');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev-test',
      default_server: { api_base_url: api, app_base_url: api, device_id: 'dev-test' },
      bindings: [],
    })
  );
  writeFileSync(
    join(configDir, '.token'),
    JSON.stringify({ v: 2, access: 'test-token', access_expires_at: 9_999_999_999 })
  );

  env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData'),
    AGENTBOARD_CONFIG_DIR: configDir,
    CODEX_HOME: join(root, 'codex'),
    AGENTBOARD_SWEEP: 'off',
    AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE: '0',
  };
  delete env.AGENTBOARD_INTERNAL;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('codex notify across rollout pages', () => {
  it('uploads the turns written to a later page of the thread', async () => {
    writeRollout(`rollout-2026-09-10T10-00-00-${THREAD}.jsonl`, 400, '2026-09-10T10:00:00.000Z');
    expect((await notify()).code).toBe(0);
    expect(uploadedTokens()).toBe(500);

    writeRollout(`rollout-2026-09-10T11-00-00-${THREAD}_${PAGE}.jsonl`, 900, '2026-09-10T11:00:00.000Z');
    expect((await notify()).code).toBe(0);
    // Before the fix: still 500, the later page never read.
    expect(uploadedTokens()).toBe(1500);
    expect(received.every((e) => e.session_id === THREAD)).toBe(true);

    expect((await notify()).code).toBe(0);
    expect(uploadedTokens()).toBe(1500);
  });
});
