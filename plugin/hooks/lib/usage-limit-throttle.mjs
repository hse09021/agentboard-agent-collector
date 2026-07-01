/**
 * agentboard usage-limit throttle
 *
 * Codex only fires its notify hook per-turn (no true session-end signal),
 * so running `/status` on every turn would be wasteful. This tracks the
 * last successful capture time per source in
 * ~/.agentboard/usage-limit-state.json and gates re-capture on a minimum
 * interval. Claude Code's SessionEnd already fires once per session, so
 * this mostly just guards against rapid session churn there too.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const DEFAULT_MIN_INTERVAL_MS = 15 * 60_000;

export function getUsageLimitStatePath(configDir = CONFIG_DIR) {
  return join(configDir, 'usage-limit-state.json');
}

function loadState(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(statePath, state) {
  try {
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/**
 * @param {string} source - e.g. 'claude_code' | 'codex'
 * @param {{minIntervalMs?: number, configDir?: string}} [opts]
 */
export function shouldCaptureUsageLimit(source, opts = {}) {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const statePath = getUsageLimitStatePath(opts.configDir ?? CONFIG_DIR);
  const state = loadState(statePath);
  const lastCapturedAt = state[source]?.lastCapturedAt;
  if (!lastCapturedAt) return true;
  const elapsed = Date.now() - new Date(lastCapturedAt).getTime();
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= minIntervalMs;
}

/**
 * @param {string} source
 * @param {{configDir?: string}} [opts]
 */
export function markUsageLimitCaptured(source, opts = {}) {
  const statePath = getUsageLimitStatePath(opts.configDir ?? CONFIG_DIR);
  const state = loadState(statePath);
  state[source] = { lastCapturedAt: new Date().toISOString() };
  saveState(statePath, state);
}
