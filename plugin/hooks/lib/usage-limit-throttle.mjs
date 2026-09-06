/**
 * agentboard usage-limit throttle
 *
 * A capture runs `claude -p /usage` (or Codex's rate-limit RPC), so it costs a
 * subprocess. This gates how often that happens.
 *
 * v0.7.0 made the gate per-route as well as per-source. The reason is not
 * performance:
 *
 *   A snapshot is only ever attached to an upload going to the session's own
 *   route, so an organization only sees limit readings taken while its own work
 *   was happening. Keeping a single source-wide throttle would mean a developer
 *   alternating between a company project and a personal one leaves one of the
 *   two servers without a reading for a long stretch. Caching one capture and
 *   handing it to both routes would fix the gap but break the property — a
 *   reading taken during personal work would end up on the employer's server.
 *
 *   So each route gets its own 10-minute cadence, and a global floor per source
 *   bounds the cost so that rapid switching cannot spawn a capture per switch.
 *
 * State file (v2):
 *   { version: 2, sources: { <source>: {...} }, routes: { <source>:<route>: {...} } }
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';

// Per-route cadence. A capture happens only when a hook fires AND this much
// time has passed, so it is an upper bound rather than a background timer.
const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;

// Global floor per source. Without it, alternating between two projects would
// trigger a capture on every switch.
const GLOBAL_FLOOR_MS = 90_000;

export function getUsageLimitStatePath(configDir = CONFIG_DIR) {
  return join(configDir, 'usage-limit-state.json');
}

function loadState(statePath) {
  if (!existsSync(statePath)) return { version: 2, sources: {}, routes: {} };

  let raw;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { version: 2, sources: {}, routes: {} };
  }

  if (raw && raw.version === 2) {
    return { version: 2, sources: raw.sources ?? {}, routes: raw.routes ?? {} };
  }

  // v1 was a flat { <source>: { lastCapturedAt } }. Promote it into `sources`
  // so the existing floor is honoured; `routes` starts empty, which means each
  // route captures once soon after the upgrade (bounded by the global floor).
  const sources = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value && typeof value === 'object' && value.lastCapturedAt) {
      sources[key] = { lastCapturedAt: value.lastCapturedAt };
    }
  }
  return { version: 2, sources, routes: {} };
}

function saveState(statePath, state) {
  try {
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeJsonAtomic(statePath, state);
  } catch {
    // best-effort
  }
}

function elapsedSince(iso, now) {
  if (!iso) return Infinity;
  const elapsed = now - new Date(iso).getTime();
  return Number.isFinite(elapsed) ? elapsed : Infinity;
}

function routeKey(source, route) {
  return `${source}:${route ?? 'default'}`;
}

/**
 * @param {string} source - 'claude_code' | 'codex'
 * @param {{minIntervalMs?: number, route?: string, configDir?: string, now?: number}} [opts]
 *        `minIntervalMs: 0` (used by SessionEnd) bypasses the per-route cadence
 *        but NOT the global floor.
 */
export function shouldCaptureUsageLimit(source, opts = {}) {
  const now = opts.now ?? Date.now();
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const statePath = getUsageLimitStatePath(opts.configDir ?? CONFIG_DIR);
  const state = loadState(statePath);

  // The floor applies to everyone, including SessionEnd, because it exists to
  // bound subprocess cost rather than to schedule readings.
  if (elapsedSince(state.sources[source]?.lastCapturedAt, now) < GLOBAL_FLOOR_MS) {
    return false;
  }

  return elapsedSince(state.routes[routeKey(source, opts.route)]?.lastCapturedAt, now) >= minIntervalMs;
}

/**
 * @param {string} source
 * @param {{route?: string, configDir?: string, now?: number}} [opts]
 */
export function markUsageLimitCaptured(source, opts = {}) {
  const now = opts.now ?? Date.now();
  const statePath = getUsageLimitStatePath(opts.configDir ?? CONFIG_DIR);
  const state = loadState(statePath);
  const at = new Date(now).toISOString();

  state.sources[source] = { lastCapturedAt: at };
  state.routes[routeKey(source, opts.route)] = { lastCapturedAt: at };

  saveState(statePath, state);
}
