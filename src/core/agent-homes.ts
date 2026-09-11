/**
 * agentboard agent-home registry (CLI side)
 *
 * Deliberate duplication of plugin/hooks/lib/agent-homes.mjs — the hooks run as
 * plain .mjs outside the compiled TypeScript context, the same arrangement as
 * routing.ts/.mjs and path-normalize.ts/.mjs. When one side changes, change
 * both.
 *
 * An "agent home" is the config directory a CLI actually reads. It is not
 * always under homedir(): Codex honours CODEX_HOME and Claude Code honours
 * CLAUDE_CONFIG_DIR, and agent orchestrators use both — Orca runs Codex against
 * its own runtime home, so hooks installed only into ~/.codex never fire there
 * and rollouts written there are never found.
 *
 * The registry is never built by searching the filesystem. Candidates come from
 * four bounded sources: the defaults, what install-hooks wrote to, what a hook
 * observed in its own environment, and deterministic orchestrator paths that
 * are checked for existence but never hunted for.
 *
 * Keep in sync with plugin/hooks/lib/agent-homes.mjs.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfigDir } from "./config";
import { writeJsonAtomic } from "./atomic-write";
import { normalizePath } from "./path-normalize";

export type AgentHomeKind = "codex" | "claude_code";
export type AgentHomeOrigin = "default" | "install" | "runtime" | "orca";

export interface AgentHomeEntry {
  kind: AgentHomeKind;
  /** Original (non-normalized) form — this is what gets used. */
  dir: string;
  origin: AgentHomeOrigin;
  firstSeenAt: string;
  lastSeenAt: string;
  missCount?: number;
}

interface AgentHomeRegistry {
  version: 1;
  homes: AgentHomeEntry[];
}

export const AGENT_HOME_KINDS: AgentHomeKind[] = ["codex", "claude_code"];
export const MAX_HOMES_PER_KIND = 16;

export function getAgentHomesPath(): string {
  return path.join(getConfigDir(), "agent-homes.json");
}

function emptyRegistry(): AgentHomeRegistry {
  return { version: 1, homes: [] };
}

export function loadAgentHomes(): AgentHomeRegistry {
  const file = getAgentHomesPath();
  if (!fs.existsSync(file)) return emptyRegistry();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as AgentHomeRegistry;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.homes)) return emptyRegistry();
    return {
      version: 1,
      homes: raw.homes.filter(
        (h) => h && typeof h.dir === "string" && AGENT_HOME_KINDS.includes(h.kind)
      ),
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveAgentHomes(registry: AgentHomeRegistry): boolean {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    writeJsonAtomic(getAgentHomesPath(), registry);
    return true;
  } catch {
    return false;
  }
}

function evictOverflow(homes: AgentHomeEntry[]): AgentHomeEntry[] {
  for (const kind of AGENT_HOME_KINDS) {
    const evictable = homes
      .filter((h) => h.kind === kind && h.origin !== "default")
      .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));
    const overflow = evictable.length - MAX_HOMES_PER_KIND;
    for (let i = 0; i < overflow; i++) {
      const idx = homes.indexOf(evictable[i]);
      if (idx >= 0) homes.splice(idx, 1);
    }
  }
  return homes;
}

/** Idempotent under normalizePath(). Returns true when newly added. */
export function recordAgentHome(
  kind: AgentHomeKind,
  dir: string,
  origin: AgentHomeOrigin
): boolean {
  const key = normalizePath(dir);
  if (!key || !AGENT_HOME_KINDS.includes(kind)) return false;

  const registry = loadAgentHomes();
  const now = new Date().toISOString();
  const existing = registry.homes.find(
    (h) => h.kind === kind && normalizePath(h.dir) === key
  );

  if (existing) {
    // Origin is upgraded but never downgraded: "we installed hooks here" is the
    // stronger statement about how a home got into the registry.
    if (existing.origin === "runtime" && origin === "install") existing.origin = origin;
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

export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

export function defaultClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

function orcaUserDataDirs(): string[] {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return [path.join(appData, "Orca")];
  }
  if (process.platform === "darwin") {
    return [path.join(os.homedir(), "Library", "Application Support", "Orca")];
  }
  return [path.join(os.homedir(), ".local", "share", "orca")];
}

/**
 * Where Orca keeps a hot-swapped account's config home, per agent. It creates
 * <userData>/<accountsDir>/<accountId>/<leaf>, drops a marker inside it, and
 * points CODEX_HOME / CLAUDE_CONFIG_DIR at it — so that account's settings and
 * transcripts live there instead of under ~/. The two agents do not share a
 * layout: Codex ends in `home`, Claude in `auth`, and the markers differ.
 */
const ORCA_ACCOUNT_LAYOUTS: Record<
  AgentHomeKind,
  { accountsDir: string; leaf: string; marker: string }
> = {
  codex: { accountsDir: "codex-accounts", leaf: "home", marker: ".orca-managed-home" },
  claude_code: {
    accountsDir: "claude-accounts",
    leaf: "auth",
    marker: ".orca-managed-claude-auth",
  },
};

/**
 * One readdir of a single deterministic directory whose every child is by
 * definition a managed home for that agent, each still gated on Orca's own
 * marker file — nothing outside <accountsDir>/ is ever looked at.
 */
function orcaManagedAccountHomes(kind: AgentHomeKind): string[] {
  const layout = ORCA_ACCOUNT_LAYOUTS[kind];
  if (!layout) return [];

  const out: string[] = [];
  for (const root of orcaUserDataDirs()) {
    const accountsDir = path.join(root, layout.accountsDir);
    if (!fs.existsSync(accountsDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(accountsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const home = path.join(accountsDir, entry.name, layout.leaf);
      if (fs.existsSync(path.join(home, layout.marker))) out.push(home);
    }
  }
  return out;
}

export function orcaCodexHomes(): string[] {
  return [
    ...orcaUserDataDirs()
      .map((root) => path.join(root, "codex-runtime-home", "home"))
      .filter((dir) => fs.existsSync(dir)),
    ...orcaManagedAccountHomes("codex"),
  ];
}

/**
 * Claude under Orca has no shared runtime home — only per-account ones. Until a
 * second account exists, Orca runs Claude against ~/.claude, which is why this
 * usually returns nothing.
 */
export function orcaClaudeHomes(): string[] {
  return orcaManagedAccountHomes("claude_code");
}

function envHomesFor(kind: AgentHomeKind, env: NodeJS.ProcessEnv): string[] {
  const raw = kind === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
  const trimmed = raw?.trim();
  return trimmed ? [trimmed] : [];
}

function defaultHomeFor(kind: AgentHomeKind): string {
  return kind === "codex" ? defaultCodexHome() : defaultClaudeHome();
}

function orcaHomesFor(kind: AgentHomeKind): string[] {
  return kind === "codex" ? orcaCodexHomes() : orcaClaudeHomes();
}

/**
 * Every home of `kind`, most-specific first, deduped on the normalized form and
 * filtered to what exists.
 */
export function listAgentHomes(
  kind: AgentHomeKind,
  opts: { env?: NodeJS.ProcessEnv; includeMissing?: boolean } = {}
): AgentHomeEntry[] {
  const env = opts.env ?? process.env;
  const now = new Date().toISOString();
  const registry = loadAgentHomes();

  const candidates: AgentHomeEntry[] = [
    ...envHomesFor(kind, env).map((dir) => ({ dir, origin: "runtime" as AgentHomeOrigin })),
    ...registry.homes.filter((h) => h.kind === kind),
    ...orcaHomesFor(kind).map((dir) => ({ dir, origin: "orca" as AgentHomeOrigin })),
    { dir: defaultHomeFor(kind), origin: "default" as AgentHomeOrigin },
  ].map((h) => ({
    kind,
    dir: h.dir,
    origin: (h as AgentHomeEntry).origin ?? "runtime",
    firstSeenAt: (h as AgentHomeEntry).firstSeenAt ?? now,
    lastSeenAt: (h as AgentHomeEntry).lastSeenAt ?? now,
  }));

  const seen = new Set<string>();
  const out: AgentHomeEntry[] = [];
  for (const entry of candidates) {
    const key = normalizePath(entry.dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!opts.includeMissing && !fs.existsSync(entry.dir)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Does this directory already look like an agent's config home?
 *
 * install-hooks must never CREATE one. Writing settings.json into an arbitrary
 * directory that merely appeared in the environment would litter the filesystem
 * with config for a tool that was never installed there.
 */
export function looksLikeAgentHome(kind: AgentHomeKind, dir: string): boolean {
  if (!fs.existsSync(dir)) return false;

  // Orca's own marker settles it. A freshly added account has neither settings
  // nor transcripts yet — Claude's is created with only credentials in it — so
  // requiring those would refuse to instrument exactly the home that most needs
  // it, and the first session under that account would go uncollected until a
  // sweep caught up.
  if (fs.existsSync(path.join(dir, ORCA_ACCOUNT_LAYOUTS[kind].marker))) return true;

  if (kind === "codex") {
    return (
      fs.existsSync(path.join(dir, "config.toml")) || fs.existsSync(path.join(dir, "sessions"))
    );
  }
  return (
    fs.existsSync(path.join(dir, "settings.json")) || fs.existsSync(path.join(dir, "projects"))
  );
}

/**
 * Homes install-hooks should write to: everything listAgentHomes knows about
 * that actually looks like an agent home, plus the default home unconditionally
 * (a first install has to be able to create ~/.claude/settings.json).
 */
export function discoverInstallTargets(
  kind: AgentHomeKind,
  opts: { extraDirs?: string[]; env?: NodeJS.ProcessEnv } = {}
): AgentHomeEntry[] {
  const now = new Date().toISOString();
  const found = listAgentHomes(kind, { env: opts.env }).filter(
    (home) => home.origin === "default" || looksLikeAgentHome(kind, home.dir)
  );

  const seen = new Set(found.map((h) => normalizePath(h.dir)));
  const out = [...found];

  // A --home the user named explicitly still has to be a real agent home.
  for (const dir of opts.extraDirs ?? []) {
    const key = normalizePath(dir);
    if (!key || seen.has(key) || !looksLikeAgentHome(kind, dir)) continue;
    seen.add(key);
    out.push({ kind, dir, origin: "install", firstSeenAt: now, lastSeenAt: now });
  }

  const defaultKey = normalizePath(defaultHomeFor(kind));
  if (defaultKey && !seen.has(defaultKey)) {
    out.push({
      kind,
      dir: defaultHomeFor(kind),
      origin: "default",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
  return out;
}

export function getCodexSessionsDirs(): string[] {
  return listAgentHomes("codex")
    .map((home) => path.join(home.dir, "sessions"))
    .filter((dir) => fs.existsSync(dir));
}

export function getClaudeProjectsDirs(): string[] {
  return listAgentHomes("claude_code")
    .map((home) => path.join(home.dir, "projects"))
    .filter((dir) => fs.existsSync(dir));
}
