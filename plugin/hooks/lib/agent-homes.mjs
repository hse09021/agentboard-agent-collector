/**
 * agentboard agent-home registry (hook runtime)
 *
 * An "agent home" is the config directory a CLI actually reads: `~/.codex` for
 * Codex, `~/.claude` for Claude Code — unless something moved it. Agent
 * orchestrators do move it. Orca launches Codex with CODEX_HOME pointed at its
 * own runtime home and can launch Claude Code with CLAUDE_CONFIG_DIR pointed at
 * a per-account directory, so a collector that assumes homedir() finds neither
 * the hooks it installed nor the transcripts it needs to parse.
 *
 * This module is the single place that answers "which homes exist on this
 * machine". It is deliberately NOT a filesystem search: the registry is built
 * from four bounded sources only —
 *
 *   1. the defaults (~/.codex, ~/.claude)
 *   2. what install-hooks wrote to        (origin: 'install')
 *   3. what a hook observed in its own env (origin: 'runtime') — a hook spawned
 *      by an agent inherits that agent's CODEX_HOME / CLAUDE_CONFIG_DIR, which
 *      is the most reliable signal there is
 *   4. deterministic orchestrator paths, existsSync-gated (origin: 'orca')
 *
 * Scanning the disk for candidate homes would widen data collection to tools
 * the user never asked us to instrument. Checking whether one known path exists
 * is not a search.
 *
 * Privacy note — what may be stored here: agent home ROOTS only (`~/.codex`,
 * `…/Orca/codex-runtime-home/home`). These are tool config directories; they
 * say nothing about what the user is working on, and config.json already stores
 * comparable paths in its bindings. Session/transcript paths are a different
 * class of data entirely — they carry project and repo names — and must never
 * be persisted. That is what lib/scan-cache.mjs hashes.
 *
 * Keep in sync with src/core/agent-homes.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { normalizePath } from './path-normalize.mjs';

/** @typedef {'codex'|'claude_code'} AgentHomeKind */
/** @typedef {'default'|'install'|'runtime'|'orca'} AgentHomeOrigin */
/**
 * @typedef {object} HomeEntry
 * @property {AgentHomeKind} kind
 * @property {string} dir           original (non-normalized) form — this is what gets used
 * @property {AgentHomeOrigin} origin
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {number} [missCount]   consecutive sweeps that found `dir` missing
 */

export const AGENT_HOMES_PATH = join(CONFIG_DIR, 'agent-homes.json');

/**
 * Bounds registry growth if some tool churns CODEX_HOME (a per-worktree home,
 * say). Counted per kind and excluding the built-in default, which is never
 * evicted.
 */
export const MAX_HOMES_PER_KIND = 16;

/** A home missing for this many consecutive sweeps is dropped. */
export const MAX_MISS_COUNT = 5;

export const AGENT_HOME_KINDS = /** @type {AgentHomeKind[]} */ (['codex', 'claude_code']);

function emptyRegistry() {
  return { version: 1, homes: [] };
}

export function loadAgentHomes() {
  if (!existsSync(AGENT_HOMES_PATH)) return emptyRegistry();
  try {
    const raw = JSON.parse(readFileSync(AGENT_HOMES_PATH, 'utf-8'));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.homes)) return emptyRegistry();
    return {
      version: 1,
      homes: raw.homes.filter(
        (h) => h && typeof h.dir === 'string' && AGENT_HOME_KINDS.includes(h.kind)
      ),
    };
  } catch {
    return emptyRegistry();
  }
}

/**
 * Best-effort: a registry write must never break collection. Callers treat a
 * failed save as "we'll observe this home again next time".
 */
export function saveAgentHomes(registry) {
  try {
    writeJsonAtomic(AGENT_HOMES_PATH, registry);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops the oldest non-default entries once a kind exceeds MAX_HOMES_PER_KIND.
 * `default` entries are pinned: losing ~/.codex from the registry would be a
 * silent regression to the pre-fix behaviour.
 */
function evictOverflow(homes) {
  for (const kind of AGENT_HOME_KINDS) {
    const evictable = homes
      .filter((h) => h.kind === kind && h.origin !== 'default')
      .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));
    const overflow = evictable.length - MAX_HOMES_PER_KIND;
    for (let i = 0; i < overflow; i++) {
      const idx = homes.indexOf(evictable[i]);
      if (idx >= 0) homes.splice(idx, 1);
    }
  }
  return homes;
}

/**
 * Records a home, keyed on its normalized form so `C:\Users\x\.codex\` and
 * `c:/users/x/.codex` are the same entry. Returns true when newly added.
 *
 * `origin` is upgraded but never downgraded: a home we installed hooks into
 * stays 'install' even if we later observe it in the environment, because that
 * is the stronger statement about how it got here.
 *
 * @param {AgentHomeKind} kind
 * @param {string} dir
 * @param {AgentHomeOrigin} origin
 * @returns {boolean}
 */
export function recordAgentHome(kind, dir, origin) {
  const key = normalizePath(dir);
  if (!key || !AGENT_HOME_KINDS.includes(kind)) return false;

  const registry = loadAgentHomes();
  const now = new Date().toISOString();
  const existing = registry.homes.find(
    (h) => h.kind === kind && normalizePath(h.dir) === key
  );

  if (existing) {
    // Nothing meaningful changed — skip the write. Hooks fire every turn and
    // this runs on each of them; a no-op write per turn is pure I/O churn.
    const shouldUpgrade = existing.origin === 'runtime' && origin === 'install';
    if (!shouldUpgrade && existing.missCount === undefined) return false;
    if (shouldUpgrade) existing.origin = origin;
    existing.lastSeenAt = now;
    delete existing.missCount;
    saveAgentHomes(registry);
    return false;
  }

  registry.homes.push({ kind, dir, origin, firstSeenAt: now, lastSeenAt: now });
  evictOverflow(registry.homes);
  saveAgentHomes(registry);
  return true;
}

/**
 * Records whatever home the *current process* is running under. A hook is
 * spawned by the agent whose tokens it is collecting, so it inherits that
 * agent's CODEX_HOME / CLAUDE_CONFIG_DIR — the most reliable discovery signal
 * available, and the one that makes an orchestrator-launched agent visible to
 * later sweeps.
 *
 * Cheap by design: one read, and a write only on first sight.
 */
export function recordAgentHomesFromEnv(env = process.env) {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) recordAgentHome('codex', codexHome, 'runtime');

  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeHome) recordAgentHome('claude_code', claudeHome, 'runtime');
}

export function defaultCodexHome() {
  return join(homedir(), '.codex');
}

export function defaultClaudeHome() {
  return join(homedir(), '.claude');
}

/**
 * The application-data root an Electron app would use for `orca`, per platform.
 * Hardcoded rather than searched (see the module header).
 */
function orcaUserDataDirs() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return [join(appData, 'Orca')];
  }
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Orca')];
  }
  // Linux (and WSL): matches the path Orca itself builds — the segments
  // [.local, share, orca, codex-runtime-home, home].
  return [join(homedir(), '.local', 'share', 'orca')];
}

/**
 * Where Orca keeps a hot-swapped account's config home, per agent.
 *
 * Orca creates <userData>/<accountsDir>/<accountId>/<leaf>, drops a marker file
 * inside it, and points CODEX_HOME / CLAUDE_CONFIG_DIR at it when launching an
 * agent under that account — so that account's settings AND its transcripts
 * live there instead of under ~/. The two agents do not share a layout: Codex
 * ends in `home`, Claude in `auth`, and the markers differ.
 */
const ORCA_ACCOUNT_LAYOUTS = {
  codex: { accountsDir: 'codex-accounts', leaf: 'home', marker: '.orca-managed-home' },
  claude_code: {
    accountsDir: 'claude-accounts',
    leaf: 'auth',
    marker: '.orca-managed-claude-auth',
  },
};

/**
 * One readdir of a single deterministic directory whose every child is by
 * definition a managed home for that agent, and each candidate still has to
 * carry Orca's own marker file. That is not a search for candidates — nothing
 * outside <accountsDir>/ is ever looked at.
 */
function orcaManagedAccountHomes(kind) {
  const layout = ORCA_ACCOUNT_LAYOUTS[kind];
  if (!layout) return [];

  const out = [];
  for (const root of orcaUserDataDirs()) {
    const accountsDir = join(root, layout.accountsDir);
    if (!existsSync(accountsDir)) continue;

    let entries;
    try {
      entries = readdirSync(accountsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const home = join(accountsDir, entry.name, layout.leaf);
      if (existsSync(join(home, layout.marker))) out.push(home);
    }
  }
  return out;
}

/**
 * Codex under Orca: the shared runtime home plus any hot-swapped account home.
 *
 * <userData>/codex-runtime-home/home is verified against a real install — it
 * holds its own config.toml, auth.json and a real (non-symlink) sessions dir.
 */
export function orcaCodexHomes() {
  return [
    ...orcaUserDataDirs()
      .map((root) => join(root, 'codex-runtime-home', 'home'))
      .filter((dir) => existsSync(dir)),
    ...orcaManagedAccountHomes('codex'),
  ];
}

/**
 * Claude under Orca has no shared runtime home — only per-account ones. Until a
 * second account exists, Orca runs Claude against ~/.claude, which is why this
 * usually returns nothing.
 */
export function orcaClaudeHomes() {
  return orcaManagedAccountHomes('claude_code');
}

function envHomesFor(kind, env) {
  const raw = kind === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
  const trimmed = raw?.trim();
  return trimmed ? [trimmed] : [];
}

function orcaHomesFor(kind) {
  return kind === 'codex' ? orcaCodexHomes() : orcaClaudeHomes();
}

function defaultHomeFor(kind) {
  return kind === 'codex' ? defaultCodexHome() : defaultClaudeHome();
}

/**
 * Every home of `kind` this machine has, most-specific first: the running
 * agent's own home, then the registry, then deterministic orchestrator paths,
 * then the default. Deduped on the normalized form and filtered to what
 * actually exists.
 *
 * Order matters for callers that stop at the first hit (findCodexSessionFile):
 * the env home is where the agent that spawned us is actually writing.
 *
 * @param {AgentHomeKind} kind
 * @param {{env?: NodeJS.ProcessEnv, includeMissing?: boolean}} [opts]
 * @returns {HomeEntry[]}
 */
export function listAgentHomes(kind, opts = {}) {
  const env = opts.env ?? process.env;
  const registry = loadAgentHomes();
  const now = new Date().toISOString();

  /** @type {HomeEntry[]} */
  const candidates = [
    ...envHomesFor(kind, env).map((dir) => ({ dir, origin: 'runtime' })),
    ...registry.homes.filter((h) => h.kind === kind),
    ...orcaHomesFor(kind).map((dir) => ({ dir, origin: 'orca' })),
    { dir: defaultHomeFor(kind), origin: 'default' },
  ].map((h) => ({
    kind,
    dir: h.dir,
    origin: h.origin ?? 'runtime',
    firstSeenAt: h.firstSeenAt ?? now,
    lastSeenAt: h.lastSeenAt ?? now,
  }));

  const seen = new Set();
  const out = [];
  for (const entry of candidates) {
    const key = normalizePath(entry.dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!opts.includeMissing && !existsSync(entry.dir)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Ages out homes that have gone missing for MAX_MISS_COUNT consecutive sweeps.
 * Called by the sweep, not by the hot path: a home can be transiently absent
 * (an unmounted network drive, a OneDrive folder mid-sync), and evicting on the
 * first miss would drop a perfectly good home.
 *
 * @param {string[]} missingDirs normalized dirs that were absent this run
 */
export function noteMissingHomes(missingDirs) {
  if (!missingDirs?.length) return;
  const missing = new Set(missingDirs);
  const registry = loadAgentHomes();
  let changed = false;

  registry.homes = registry.homes.filter((home) => {
    const key = normalizePath(home.dir);
    if (!key || !missing.has(key)) return true;
    if (home.origin === 'default') return true;
    home.missCount = (home.missCount ?? 0) + 1;
    changed = true;
    return home.missCount < MAX_MISS_COUNT;
  });

  if (changed) saveAgentHomes(registry);
}

/** @returns {string[]} every <home>/sessions that exists, most-specific first. */
export function getCodexSessionsDirs(opts = {}) {
  return listAgentHomes('codex', opts)
    .map((home) => join(home.dir, 'sessions'))
    .filter((dir) => existsSync(dir));
}

/** @returns {string[]} every <home>/projects that exists, most-specific first. */
export function getClaudeProjectsDirs(opts = {}) {
  return listAgentHomes('claude_code', opts)
    .map((home) => join(home.dir, 'projects'))
    .filter((dir) => existsSync(dir));
}
