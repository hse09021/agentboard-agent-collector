/**
 * agentboard config schema v2 — multi-server routing
 *
 * v1 held a single server as three flat scalars (device_id / api_base_url /
 * app_base_url), so the collector could only ever talk to one server. v2 keeps
 * a default server plus a list of directory bindings, each pointing at its own
 * server with its own credential.
 *
 * Two invariants make the rest of the system safe:
 *
 *   1. `abs_dir` is unique across all bindings. That is what guarantees
 *      "one session resolves to exactly one server", which in turn is why the
 *      delta ledger and session lock keys did not need a server dimension.
 *   2. Every server carries its own `device_id`. Reusing one id across servers
 *      would let two server operators correlate the same machine at zero cost
 *      to them; per-server ids remove that for free.
 *
 * Migration is a pure function so the hook runtime and the CLI can promote a v1
 * config independently and land on the same result. Only the CLI ever writes.
 *
 * Keep in sync with plugin/hooks/lib/config.mjs.
 */

export const CONFIG_VERSION = 2 as const;

/** Where snapshots of the CLI's own rate-limit status are sent. */
export type SnapshotTarget = "routed" | "default" | "off";

/**
 * Cross-agent sweep over registered agent homes.
 *
 * Collection is hook-driven, which leaves a hole: when an orchestrator runs one
 * agent as the main agent and a *different* CLI as a sub-agent, that sub-agent
 * has its own config home, and if our hooks were never installed there nothing
 * ever fires for it. The sweep closes it — whenever any hook fires, sessions in
 * every known agent home are collected too.
 *
 *   "registered" — sweep the homes in agent-homes.json: install targets, homes
 *     observed in a hook's own CODEX_HOME / CLAUDE_CONFIG_DIR, and
 *     deterministic orchestrator paths. The filesystem is never searched for
 *     candidates, sessions older than the cutoff are recorded rather than
 *     uploaded, and each session resolves its OWN route from its OWN cwd — a
 *     session whose route has no credential is skipped, never redirected.
 *   "off" — collect only the session whose hook fired.
 */
export type SweepMode = "registered" | "off";

export interface ServerRef {
  api_base_url: string;
  app_base_url: string;
  label?: string;
  /** Per-server device id. See invariant 2 above. */
  device_id?: string;
}

export interface Binding {
  /** Directory as the user typed it. */
  abs_dir: string;
  /** realpath() of abs_dir at connect time; both are matched at routing time. */
  real_dir: string;
  server: ServerRef;
  /** Display-only, supplied by the server at enrollment. */
  project_label?: string;
  /** Filename stem under credentials/. */
  credential_ref: string;
  connected_at: string;
}

export interface CollectorConfigV2 {
  version: typeof CONFIG_VERSION;

  // ── Downgrade mirror ─────────────────────────────────────────────────────
  // v0.6.x reads these three keys and knows nothing else. Keeping them in sync
  // with default_server means rolling back the collector does not silently
  // redirect a self-hosted user's uploads to the SaaS default.
  device_id?: string;
  api_base_url: string;
  app_base_url: string;

  default_server: ServerRef;
  bindings: Binding[];
  snapshot_target: SnapshotTarget;
  /**
   * Deliberately absent from the downgrade mirror above: v0.6.x ignores unknown
   * keys, so a rolled-back collector simply does not sweep — the conservative
   * degradation, and the correct one.
   */
  sweep: SweepMode;
}

/** The v1 shape, for migration only. */
export interface CollectorConfigV1 {
  device_id?: string;
  api_base_url?: string;
  app_base_url?: string;
}

export const DEFAULT_API_URL = "https://agentboard.cloud/api/proxy";
export const DEFAULT_APP_URL = "https://agentboard.cloud";

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// agentboard.kro.kr was the original host and no longer serves the API. A saved
// config always wins over the default, so installs from before the move would
// keep uploading to a dead host forever.
const LEGACY_HOSTS = new Set(["agentboard.kro.kr", "www.agentboard.kro.kr"]);
const CURRENT_HOST = "agentboard.cloud";

export function migrateLegacyHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (!LEGACY_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = "https:";
    parsed.host = CURRENT_HOST;
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeServer(server: ServerRef): ServerRef {
  return {
    ...server,
    api_base_url: stripTrailingSlash(migrateLegacyHost(server.api_base_url)),
    app_base_url: stripTrailingSlash(migrateLegacyHost(server.app_base_url)),
  };
}

export function isV2(raw: unknown): raw is CollectorConfigV2 {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { version?: unknown }).version === CONFIG_VERSION
  );
}

/**
 * Promotes a v1 config (or nothing at all) to v2. Pure and idempotent.
 *
 * The environment is read ONLY to seed a brand-new config. A saved v1 URL is
 * carried over verbatim: hooks do not inherit the user's shell, so making the
 * promoted value depend on AGENTBOARD_API_URL would send a self-hosted user's
 * uploads to the SaaS default the moment a hook fires.
 */
export function migrateV1toV2(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): CollectorConfigV2 {
  if (isV2(raw)) return normalizeV2(raw);

  const v1 = (typeof raw === "object" && raw !== null ? raw : {}) as CollectorConfigV1;

  const envApi = env.AGENTBOARD_API_URL ? stripTrailingSlash(env.AGENTBOARD_API_URL) : undefined;
  const envApp = env.AGENTBOARD_APP_URL ? stripTrailingSlash(env.AGENTBOARD_APP_URL) : undefined;

  const apiBaseUrl = stripTrailingSlash(
    migrateLegacyHost(v1.api_base_url ?? envApi ?? DEFAULT_API_URL)
  );

  let appBaseUrl: string;
  if (v1.app_base_url) {
    appBaseUrl = stripTrailingSlash(migrateLegacyHost(v1.app_base_url));
  } else if (envApp) {
    appBaseUrl = envApp;
  } else {
    try {
      appBaseUrl = stripTrailingSlash(new URL(apiBaseUrl).origin);
    } catch {
      appBaseUrl = DEFAULT_APP_URL;
    }
  }

  const defaultServer: ServerRef = {
    api_base_url: apiBaseUrl,
    app_base_url: appBaseUrl,
    label: labelForUrl(appBaseUrl),
    device_id: v1.device_id,
  };

  return {
    version: CONFIG_VERSION,
    device_id: v1.device_id,
    api_base_url: apiBaseUrl,
    app_base_url: appBaseUrl,
    default_server: defaultServer,
    bindings: [],
    snapshot_target: "routed",
    sweep: "registered",
  };
}

function labelForUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Fills in defaults and re-syncs the downgrade mirror. */
export function normalizeV2(raw: CollectorConfigV2): CollectorConfigV2 {
  const defaultServer = normalizeServer({
    api_base_url: raw.default_server?.api_base_url ?? DEFAULT_API_URL,
    app_base_url: raw.default_server?.app_base_url ?? DEFAULT_APP_URL,
    label: raw.default_server?.label,
    device_id: raw.default_server?.device_id ?? raw.device_id,
  });

  const bindings = (Array.isArray(raw.bindings) ? raw.bindings : []).map((b) => ({
    ...b,
    server: normalizeServer(b.server),
  }));

  return {
    version: CONFIG_VERSION,
    // Mirror always tracks the default server, never a binding.
    device_id: defaultServer.device_id,
    api_base_url: defaultServer.api_base_url,
    app_base_url: defaultServer.app_base_url,
    default_server: defaultServer,
    bindings,
    snapshot_target: raw.snapshot_target ?? "routed",
    // Anything unrecognised coerces to the documented default rather than
    // throwing: a typo in a hand-edited config must not stop collection.
    sweep: raw.sweep === "off" ? "off" : "registered",
  };
}
