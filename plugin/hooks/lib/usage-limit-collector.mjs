/**
 * agentboard usage-limit collector
 *
 * Shells out to each CLI's own usage-status mechanism and captures the raw
 * result. This is the ONLY module that knows how to invoke those commands —
 * swap `claudeUsageCommand()` / `readCodexRateLimits()` if the exact
 * invocation needs to change.
 *
 * NOTE: headless invocation of these interactive slash commands is NOT
 * uniformly safe — verify each CLI independently before wiring it up.
 * Confirmed against codex-cli 0.142.4/0.142.5 (see /codex.md): `codex exec
 * "/status"` does NOT run the /status slash command — it runs "/status" as
 * a brand-new agent prompt, consuming a real, billable turn.
 * `codexStatusCommand()` is therefore deliberately NOT wired up anywhere —
 * do not call it.
 *
 * `claudeUsageCommand()` does NOT have that risk — confirmed 2026-07-01
 * (see lib/usage-limit.mjs SAFETY note) that `spawn('claude', ['-p',
 * '/usage'])` is a local, non-billable status read.
 *
 * `readCodexRateLimits()` also does NOT have that risk, via a different
 * mechanism: it talks to `codex app-server`'s stdio JSON-RPC protocol and
 * calls `account/rateLimits/read` — a pure account-metadata read, not
 * `codex exec`. Confirmed 2026-07-01: never opens a `thread/start` (no
 * session/turn), produces zero new files under `~/.codex/sessions` or
 * `~/.codex/log`, and returns byte-identical `usedPercent` across 8
 * back-to-back calls in the same connection (no quota drift from the read
 * itself). Both are wired up and on by default.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeUsageCommand() {
  return { command: 'claude', args: ['-p', '/usage'] };
}

function normalizeClaudePlanName(value) {
  if (typeof value !== 'string') return undefined;

  const normalized = value.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!normalized) return undefined;

  if (/\bmax\b/.test(normalized) && /\b20x?\b/.test(normalized)) return 'max20x';
  if (/\bmax\b/.test(normalized) && /\b5x?\b/.test(normalized)) return 'max5x';
  if (/\bpro\b/.test(normalized)) return 'pro';
  if (/\bfree\b/.test(normalized)) return 'free';
  if (/\bteam\b/.test(normalized)) return 'team';
  if (/\bbusiness\b/.test(normalized)) return 'business';
  if (/\benterprise\b/.test(normalized)) return 'enterprise';

  return undefined;
}

/**
 * Reads Claude Code's local account metadata and returns only the normalized
 * plan name. Access/refresh tokens are never returned or uploaded.
 *
 * @param {{credentialsPath?: string}} [opts]
 * @returns {string|undefined}
 */
export function readClaudeSubscriptionPlan(opts = {}) {
  const credentialsPath =
    opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json');

  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
    const account = parsed?.claudeAiOauth;
    const candidates = [account?.subscriptionType, account?.rateLimitTier];

    for (const candidate of candidates) {
      const planName = normalizeClaudePlanName(candidate);
      if (planName) return planName;
    }
  } catch {
    // Best-effort only. Missing/changed credential files must not affect
    // usage snapshot capture.
  }

  return undefined;
}

// NOT SAFE TO USE — see module docstring. Kept only so a future fix has
// a documented starting point if `codex exec` slash commands ever become
// genuinely headless-safe.
export function codexStatusCommand() {
  return { command: 'codex', args: ['exec', '/status'] };
}

/**
 * Run a command and capture stdout, bounded by a timeout. Never throws.
 *
 * @param {{command: string, args: string[], timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, raw: string, exitCode: number|null, durationMs: number, error?: string}>}
 */
export function captureUsageLimitRaw({ command, args, timeoutMs = 8000 }) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ durationMs: Date.now() - startedAt, ...result });
    };

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, raw: '', exitCode: null, error: err.message });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
      finish({ ok: false, raw: stdout, exitCode: null, error: 'timeout' });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, raw: stdout, exitCode: null, error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, raw: stdout, exitCode: code });
      } else {
        finish({ ok: false, raw: stdout || stderr, exitCode: code, error: `exit code ${code}` });
      }
    });
  });
}

/**
 * codex app-server ships only as a `.cmd`/`.ps1` shim on Windows (no native
 * exe, unlike `claude.exe`), so a bare `spawn('codex', ...)` fails with
 * ENOENT there — Windows can't execute a .cmd via CreateProcess directly.
 * `shell: true` is required to invoke the shim; the args passed alongside
 * it are fixed literals (never user input), so the usual shell-injection
 * concern that comes with `shell: true` does not apply here.
 */
function codexAppServerSpawnOptions() {
  if (process.platform === 'win32') {
    return { command: 'codex.cmd', shell: true };
  }
  return { command: 'codex', shell: false };
}

/**
 * Reads Codex account rate limits via `codex app-server`'s stdio JSON-RPC
 * protocol: `initialize` (required — `account/rateLimits/read` returns a
 * "Not initialized" JSON-RPC error without it) followed by
 * `account/rateLimits/read` (no params). Both requests are written
 * immediately without waiting for the initialize response — pipelining
 * them works, the server just processes them in order — bounded by
 * `timeoutMs` overall. Never throws; the app-server process is always
 * killed before resolving.
 *
 * @param {{timeoutMs?: number, spawnImpl?: typeof spawn}} [opts]
 * @returns {Promise<{ok: boolean, raw: string, result?: object, error?: string, durationMs: number}>}
 */
export function readCodexRateLimits({ timeoutMs = 8000, spawnImpl = spawn } = {}) {
  const startedAt = Date.now();
  const { command, shell } = codexAppServerSpawnOptions();

  return new Promise((resolve) => {
    let settled = false;
    let child;
    let stdoutBuf = '';
    let lastRaw = '';
    // Declared before any code that could call finish() (e.g. the spawn
    // try/catch below), so finish()'s clearTimeout(timer) never hits a
    // "Cannot access before initialization" TDZ error — clearTimeout on an
    // still-undefined value is a safe no-op.
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {
        // best-effort
      }
      resolve({ durationMs: Date.now() - startedAt, ...result });
    };

    try {
      child = spawnImpl(command, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, raw: '', error: err.message });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, raw: lastRaw, error: 'timeout' });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({ ok: false, raw: lastRaw, error: err.message });
    });

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line.trim()) continue;
        lastRaw = line;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue; // id 1 = initialize, notifications have no id

        if (msg.result) {
          finish({ ok: true, raw: line, result: msg.result });
        } else {
          finish({ ok: false, raw: line, error: msg.error?.message ?? 'rpc error' });
        }
        return;
      }
    });

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'agentboard-collector', version: '1' } },
        }) + '\n'
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null }) + '\n'
      );
    } catch (err) {
      finish({ ok: false, raw: lastRaw, error: err.message });
    }
  });
}
