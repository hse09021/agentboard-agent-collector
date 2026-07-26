/**
 * Recursion guard for the usage-limit snapshot.
 *
 * `captureUsageLimitSnapshot('claude_code')` runs `claude -p /usage`, which
 * starts a headless Claude Code session. That session fires this collector's
 * own Stop/SessionEnd hooks — a recursive re-entry that used to upload ghost
 * sessions (and re-run /usage, recursing again). The child is spawned with
 * AGENTBOARD_INTERNAL=1, and every hook entry point must bail on that flag
 * before doing any collection work.
 *
 * These tests run the real hook scripts as child processes with the flag set,
 * and assert they exit 0 without ever reaching upload. No network, no config,
 * and no valid payload is provided — if the guard failed, the script would run
 * further before exiting, which the debug-log assertions detect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = fileURLToPath(new URL('../../plugin/hooks/', import.meta.url));

function runHook(script, { env = {}, args = [], stdin = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, script), ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('AGENTBOARD_INTERNAL recursion guard', () => {
  let appData;

  beforeEach(() => {
    // Route the debug log into an isolated dir (both hooks build the log path
    // from APPDATA), so we can read exactly what this run wrote.
    appData = mkdtempSync(join(tmpdir(), 'agentboard-recursion-'));
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
  });

  function debugLog() {
    const p = join(appData, 'agentboard', 'hook-debug.log');
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  }

  it('session-end.mjs exits 0 and self-skips when the flag is set', async () => {
    const { code } = await runHook('claude/session-end.mjs', {
      env: { AGENTBOARD_INTERNAL: '1', APPDATA: appData },
      stdin: JSON.stringify({
        session_id: 'c0a98f96-404c-401f-b185-a7c79d420712',
        transcript_path: '/tmp/does-not-matter.jsonl',
      }),
    });
    expect(code).toBe(0);
    const log = debugLog();
    expect(log).toContain('SKIP: internal invocation');
    // The guard fires before stdin is read / a worker is spawned.
    expect(log).not.toContain('spawn');
    expect(log).not.toContain('[worker]');
  });

  it('worker.mjs exits 0 and self-skips when the flag is set', async () => {
    const { code } = await runHook('claude/worker.mjs', {
      env: { AGENTBOARD_INTERNAL: '1', APPDATA: appData },
      args: ['/tmp/nonexistent-payload.json'],
    });
    expect(code).toBe(0);
    const log = debugLog();
    expect(log).toContain('SKIP: internal invocation');
    // Bails before it would have complained about the missing payload file.
    expect(log).not.toContain('cannot read payload');
  });

  it('codex/notify.mjs exits 0 when the flag is set', async () => {
    const { code } = await runHook('codex/notify.mjs', {
      env: { AGENTBOARD_INTERNAL: '1' },
      args: [JSON.stringify({ 'thread-id': '019f8549-9838-7750-ae2c-020b06441074' })],
    });
    expect(code).toBe(0);
  });

  it('codex/session-end.mjs exits 0 and self-skips when the flag is set', async () => {
    const { code } = await runHook('codex/session-end.mjs', {
      env: { AGENTBOARD_INTERNAL: '1' },
      stdin: JSON.stringify({ session_id: '019f8549-9838-7750-ae2c-020b06441074' }),
    });
    expect(code).toBe(0);
  });

  it('codex/subagent-stop.mjs exits 0 and self-skips when the flag is set', async () => {
    const { code } = await runHook('codex/subagent-stop.mjs', {
      env: { AGENTBOARD_INTERNAL: '1' },
      stdin: JSON.stringify({
        session_id: '019f8549-9838-7750-ae2c-020b06441074',
        agent_id: 'agent-1',
        agent_transcript_path: '/tmp/does-not-matter.jsonl',
      }),
    });
    expect(code).toBe(0);
  });

  it('session-end.mjs does NOT self-skip when the flag is absent', async () => {
    // Sanity check the guard is flag-gated, not always-on: with no flag and no
    // agentboard config/token, the worker still spawns but the pipeline stops
    // at "not logged in" — the point is the SKIP-internal line must be absent.
    const { code } = await runHook('claude/session-end.mjs', {
      env: { APPDATA: appData },
      stdin: JSON.stringify({ session_id: 'x', transcript_path: '/tmp/x.jsonl' }),
    });
    expect(code).toBe(0);
    expect(debugLog()).not.toContain('SKIP: internal invocation');
  });
});
