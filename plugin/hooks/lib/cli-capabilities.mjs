/**
 * agentboard CLI capability probe
 *
 * Some flags we depend on do not exist in older CLI releases, and passing an
 * unknown flag makes the whole invocation fail. Probing `--help` is cheap and,
 * unlike the command we actually want to run, creates no session — so we ask
 * once and cache the answer.
 *
 * The cache carries a TTL rather than being permanent: a user who upgrades
 * Claude Code should start getting the better behaviour without having to
 * clear any state by hand.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';

const CAPABILITIES_PATH = join(CONFIG_DIR, 'cli-capabilities.json');

// Long enough that we are not spawning `--help` constantly, short enough that
// a CLI upgrade is picked up within a week.
const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadCache() {
  if (!existsSync(CAPABILITIES_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CAPABILITIES_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(CAPABILITIES_PATH, cache);
  } catch {
    // Best-effort: a missing cache only costs us an extra `--help` next time.
  }
}

/**
 * Reads `<command> --help` and reports whether `flag` appears in it.
 *
 * Failure (command missing, timeout, non-zero exit) resolves to `false`, not an
 * error: the caller's job is to decide whether to pass an optional flag, and
 * "assume unsupported" is always the safe answer.
 *
 * @param {string} command
 * @param {string} flag
 * @param {{now?: number, execImpl?: Function, ttlMs?: number}} [opts] injectable for tests
 * @returns {boolean}
 */
export function cliSupportsFlag(command, flag, opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? CAPABILITY_TTL_MS;
  const key = `${command}:${flag}`;

  const cache = loadCache();
  const hit = cache[key];
  if (hit && typeof hit.supported === 'boolean' && now - (hit.checkedAt ?? 0) < ttlMs) {
    return hit.supported;
  }

  let supported = false;
  try {
    const exec =
      opts.execImpl ??
      ((cmd) =>
        execFileSync(cmd, ['--help'], {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }));
    const help = exec(command) ?? '';
    supported = help.includes(flag);
  } catch {
    supported = false;
  }

  cache[key] = { supported, checkedAt: now };
  saveCache(cache);
  return supported;
}
