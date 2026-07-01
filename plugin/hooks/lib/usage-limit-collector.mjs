/**
 * agentboard usage-limit collector
 *
 * Shells out to the CLI's own usage-status command and captures raw stdout.
 * This is the ONLY module that knows how to invoke those commands — swap
 * `claudeUsageCommand()` if the exact invocation needs to change.
 *
 * NOTE: headless invocation of these interactive slash commands is NOT
 * confirmed safe. Confirmed against codex-cli 0.142.4 (see /codex.md):
 * `codex exec "/status"` does NOT run the /status slash command — it runs
 * "/status" as a brand-new agent prompt, consuming a real, billable turn.
 * `codexStatusCommand()` is therefore deliberately NOT wired up anywhere
 * (see lib/usage-limit.mjs) — do not call it until a real headless status
 * mechanism is found (e.g. an app-server `account/rateLimits/read` RPC
 * exposed some other way; there is currently no known CLI flag for it).
 * `claudeUsageCommand()` has the same architectural risk, unverified —
 * it is gated behind an opt-in env var, defaulting off, until confirmed.
 */

import { spawn } from 'node:child_process';

export function claudeUsageCommand() {
  return { command: 'claude', args: ['-p', '/usage'] };
}

// NOT SAFE TO USE — see module docstring. Kept only so a future fix has
// a documented starting point once a real headless mechanism is found.
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
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
