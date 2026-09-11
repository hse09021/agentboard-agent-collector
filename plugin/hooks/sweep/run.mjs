#!/usr/bin/env node
/**
 * agentboard cross-agent sweep runner
 *
 * Spawned detached by whichever hook fired (see lib/sweep.mjs maybeSpawnSweep),
 * so it never spends any part of an agent's hook timeout. Always exits 0: it is
 * a detached background process, and a non-zero exit would surface to the user
 * as a mysterious hook failure with nothing actionable behind it.
 *
 * Usage: node run.mjs [--force] [--exclude <source:sessionId>]
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfigV2, acquireSessionLock, releaseSessionLock } from '../lib/config.mjs';
import { isSweepEnabled, shouldSweep, markSweepStarted, markSweepFinished, runSweep } from '../lib/sweep.mjs';

const DEBUG_LOG = join(
  process.env.APPDATA ?? join(tmpdir(), 'agentboard'),
  'agentboard',
  'hook-debug.log'
);

function log(msg) {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [sweep] ${msg}\n`);
  } catch {
    /* best-effort */
  }
}

function parseArgs(argv) {
  const exclude = new Set();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') force = true;
    else if (argv[i] === '--exclude' && argv[i + 1]) exclude.add(argv[++i]);
  }
  return { force, exclude };
}

async function main() {
  // Same guard as every other entry point: the usage-limit capture runs
  // `claude -p /usage`, whose hooks inherit this variable. A sweep started from
  // there would collect the ghost session it just created.
  if (process.env.AGENTBOARD_INTERNAL === '1') process.exit(0);

  const { force, exclude } = parseArgs(process.argv.slice(2));

  const config = loadConfigV2();
  if (!isSweepEnabled(config)) process.exit(0);

  // One sweep at a time, machine-wide. Reuses the hooks' existing mkdir-atomic
  // lock, including its stale-holder takeover.
  if (!acquireSessionLock('sweep', 'global')) process.exit(0);
  process.on('exit', () => releaseSessionLock('sweep', 'global'));

  // Re-checked under the lock: the pre-spawn check in maybeSpawnSweep races
  // against every other hook firing at the same moment.
  if (!shouldSweep({ force })) process.exit(0);
  markSweepStarted();

  // Last-resort ceiling, mirroring the Claude worker's watchdog. Every inner
  // step is separately bounded; this only fires on a genuine hang. unref() so
  // the timer itself never holds the process open.
  const watchdog = setTimeout(() => {
    log('WATCHDOG: force-exiting');
    process.exit(0);
  }, 60_000);
  watchdog.unref();

  const report = await runSweep({ exclude, log });
  markSweepFinished(report);

  log(
    `done scanned=${report.scanned} parsed=${report.parsed} uploaded=${report.uploaded} ` +
      `seeded=${report.seeded} tokens=${report.tokens} errors=${report.errors} ` +
      `skipped=${JSON.stringify(report.skipped)} ${report.timedOut ? 'TIMED_OUT ' : ''}` +
      `in ${report.durationMs}ms`
  );
  process.exit(0);
}

main().catch((err) => {
  log(`ERROR: ${err.message}`);
  process.exit(0);
});
