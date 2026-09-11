/**
 * agentboard hook config loader
 *
 * Reads ~/.agentboard/config.json and ~/.agentboard/.token
 * Used by hook scripts that run outside the compiled TypeScript context.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.mjs';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// Re-exported so hook modules keep importing the version from here.
// The value itself is generated from package.json by scripts/generate-version.mjs
// (run by `npm run build`) — it used to be hand-copied into three files and drifted.
export { COLLECTOR_VERSION } from './version.mjs';

// Wire-format version of the UsageEvent payload. The server pins this exactly,
// so it must not be bumped without a coordinated server change.
// Keep in sync with src/core/usage-event.ts.
export const SCHEMA_VERSION = '1.0';
export const DEFAULT_API_URL = process.env.AGENTBOARD_API_URL ?? 'https://agentboard.cloud/api/proxy';

// agentboard.kro.kr was the original host and no longer serves the API. A saved
// config always wins over DEFAULT_API_URL, so installs from before the move would
// keep uploading to a dead host forever — rewrite the host whenever a config is
// read. Keep in sync with src/core/config.ts.
const LEGACY_HOSTS = new Set(['agentboard.kro.kr', 'www.agentboard.kro.kr']);
const CURRENT_HOST = 'agentboard.cloud';

function migrateLegacyHost(url) {
  try {
    const parsed = new URL(url);
    if (!LEGACY_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = 'https:';
    parsed.host = CURRENT_HOST;
    return parsed.toString();
  } catch {
    return url;
  }
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function getConfigDir() {
  // Test/CI override — mirror of src/core/config.ts. Lets a test point the
  // whole config dir somewhere disposable without stubbing HOME/APPDATA
  // process-wide (which would also move ~/.claude and ~/.codex).
  if (process.env.AGENTBOARD_CONFIG_DIR) {
    return process.env.AGENTBOARD_CONFIG_DIR;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'agentboard');
  }
  return join(homedir(), '.agentboard');
}

export const CONFIG_DIR = getConfigDir();
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const TOKEN_PATH = join(CONFIG_DIR, '.token');
export const HOOK_SENT_PATH = join(CONFIG_DIR, 'hook-sent.json');

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (config?.api_base_url) {
      config.api_base_url = stripTrailingSlash(migrateLegacyHost(config.api_base_url));
    }
    return config;
  } catch {
    return null;
  }
}

const DEFAULT_ROUTE_ID = 'default';

/**
 * Loads config.json and promotes a v1 (single-server) file to the v2 shape in
 * memory. Mirror of migrateV1toV2 in src/core/config-schema.ts — the two must
 * agree, because the hook and the CLI promote independently.
 *
 * Hooks never write config.json, so promoting in memory is safe: the CLI
 * persists the upgrade the next time it runs.
 */
export function loadConfigV2() {
  const raw = loadConfig();

  if (raw && raw.version === 2) {
    return {
      ...raw,
      default_server: normalizeServerRef(raw.default_server),
      bindings: (raw.bindings ?? []).map((b) => ({ ...b, server: normalizeServerRef(b.server) })),
      snapshot_target: raw.snapshot_target ?? 'routed',
      // Unknown values coerce to the documented default rather than throwing:
      // a typo in a hand-edited config must not silently stop collection.
      sweep: raw.sweep === 'off' ? 'off' : 'registered',
    };
  }

  // A saved v1 URL is carried over verbatim. Falling back to the environment
  // here would redirect a self-hosted user to the SaaS default, because hooks
  // do not inherit the user's shell.
  const apiBaseUrl = stripTrailingSlash(migrateLegacyHost(raw?.api_base_url ?? DEFAULT_API_URL));
  let appBaseUrl = raw?.app_base_url;
  if (!appBaseUrl) {
    try {
      appBaseUrl = new URL(apiBaseUrl).origin;
    } catch {
      appBaseUrl = 'https://agentboard.cloud';
    }
  }

  return {
    version: 2,
    device_id: raw?.device_id,
    api_base_url: apiBaseUrl,
    app_base_url: stripTrailingSlash(appBaseUrl),
    default_server: {
      api_base_url: apiBaseUrl,
      app_base_url: stripTrailingSlash(appBaseUrl),
      device_id: raw?.device_id,
    },
    bindings: [],
    snapshot_target: 'routed',
    sweep: 'registered',
  };
}

function normalizeServerRef(server) {
  if (!server) return server;
  return {
    ...server,
    api_base_url: stripTrailingSlash(migrateLegacyHost(server.api_base_url)),
    app_base_url: stripTrailingSlash(migrateLegacyHost(server.app_base_url)),
  };
}

/**
 * Credential for a route. The default route keeps using .token (written by
 * `agentboard login`); connected projects each have their own file.
 */
export function loadRouteCredential(credentialRef) {
  if (!credentialRef) return loadToken();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(credentialRef)) return null;
  const credPath = join(CONFIG_DIR, 'credentials', credentialRef + '.cred');
  if (!existsSync(credPath)) return null;
  try {
    return readFileSync(credPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(config) {
  return stripTrailingSlash(migrateLegacyHost(config?.api_base_url ?? DEFAULT_API_URL));
}

export function loadToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// ─── Session-sent tracking ────────────────────────────────────────────────────

// The delta ledger keeps one entry per session (and per subagent), read and
// rewritten on every hook invocation. Without pruning it would grow without
// bound and slow every turn. Entries carry a `sentAt`, so on each write we drop
// any older than this window. A pruned session that somehow resumes past the
// window would re-upload its cumulative once (a rare, bounded double-count), so
// the window is deliberately generous.
const HOOK_SENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function pruneHookSent(sent, nowMs) {
  for (const key of Object.keys(sent)) {
    const sentAt = sent[key]?.sentAt;
    // Entries with no parseable timestamp can't be aged — keep them rather than
    // risk dropping live state.
    if (typeof sentAt !== 'string') continue;
    const ts = Date.parse(sentAt);
    if (Number.isFinite(ts) && nowMs - ts > HOOK_SENT_MAX_AGE_MS) {
      delete sent[key];
    }
  }
  return sent;
}

export function loadHookSent() {
  if (!existsSync(HOOK_SENT_PATH)) return {};
  try {
    return JSON.parse(readFileSync(HOOK_SENT_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveHookSent(sent) {
  try {
    pruneHookSent(sent, Date.now());
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(HOOK_SENT_PATH, sent);
  } catch {
    // best-effort
  }
}

function hookSentKey(source, sessionId) {
  return `${source}:${sessionId}`;
}

export function isSessionSent(source, sessionId) {
  const sent = loadHookSent();
  return !!sent[hookSentKey(source, sessionId)];
}

export function markSessionSent(source, sessionId) {
  const sent = loadHookSent();
  sent[hookSentKey(source, sessionId)] = { sentAt: new Date().toISOString() };
  saveHookSent(sent);
}

// ─── Incremental (delta) tracking ─────────────────────────────────────────────
//
// A session's token total grows across many hook invocations: Codex fires its
// notify hook per-turn, and a Claude Code session can be resumed long after its
// first SessionEnd. Plain session-level dedup (isSessionSent) uploads only the
// first invocation and drops everything after it. So both sources instead store
// the cumulative totals already uploaded and send only the delta each time.

// cacheCreation5m/1h are a breakdown of cacheCreationTokens, not extra tokens;
// they never enter totalTokens. Ledger records written before this field pair
// existed simply read as 0, which makes the first post-upgrade delta report the
// whole split — the server clamps that against cacheCreationTokens rather than
// trusting it (see cost-estimator).
const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

function normalizeTotals(totals) {
  if (!totals || typeof totals !== 'object') return { ...ZERO_TOTALS };
  const nn = (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    inputTokens: nn(totals.inputTokens),
    outputTokens: nn(totals.outputTokens),
    cacheCreationTokens: nn(totals.cacheCreationTokens),
    cacheCreation5mTokens: nn(totals.cacheCreation5mTokens),
    cacheCreation1hTokens: nn(totals.cacheCreation1hTokens),
    cacheReadTokens: nn(totals.cacheReadTokens),
    totalTokens: nn(totals.totalTokens),
  };
}

/**
 * Return the cumulative token totals already uploaded for a session, or a
 * zero-filled object when nothing has been sent yet.
 */
export function getSentTotals(source, sessionId) {
  const sent = loadHookSent();
  const record = sent[hookSentKey(source, sessionId)];
  return normalizeTotals(record?.totals);
}

/**
 * The route a session was pinned to by its first successful upload.
 *
 * A session must never change server mid-flight: the ledger holds ONE
 * cumulative total per session, so a route change would hand the new server the
 * entire cumulative figure, including work done before the change. Records
 * written before v0.7.0 carry no route and belong to the default server.
 *
 * Returns null when the session has never uploaded, which means it is still
 * free to be routed by cwd.
 */
export function getSentRoute(source, sessionId) {
  const sent = loadHookSent();
  const record = sent[hookSentKey(source, sessionId)];
  if (!record) return null;
  // A seeded record is a watermark, not an upload: the sweep wrote it to say
  // "these tokens predate collection, never send them", and no server has ever
  // seen this session. Reporting DEFAULT_ROUTE_ID here would pin it to the
  // community server for good — so a seeded session inside a connected
  // directory would later ship that organization's work to the wrong place.
  // Still unrouted means still free to be routed by its own cwd.
  if (record.seeded && record.route === undefined) return null;
  return record.route ?? DEFAULT_ROUTE_ID;
}

/**
 * Persist the cumulative token totals uploaded so far for a session.
 *
 * `route` pins the session (see getSentRoute). Passing undefined keeps whatever
 * pin is already recorded rather than clearing it.
 */
export function markTotalsSent(source, sessionId, totals, route) {
  const sent = loadHookSent();
  const key = hookSentKey(source, sessionId);
  const previous = sent[key];
  sent[key] = {
    sentAt: new Date().toISOString(),
    totals: normalizeTotals(totals),
    ...(route ?? previous?.route ? { route: route ?? previous.route } : {}),
  };
  saveHookSent(sent);
}

/**
 * Record a session's cumulative totals WITHOUT uploading them.
 *
 * The cross-agent sweep discovers sessions that predate collection. Uploading
 * those would retroactively ship months of history the user never opted into,
 * so instead their totals are written as a watermark: the session is now known,
 * and only tokens accrued from here on are ever sent.
 *
 * Deliberately writes no `route` — see getSentRoute for why that matters.
 */
export function markTotalsSeeded(source, sessionId, totals) {
  const sent = loadHookSent();
  const key = hookSentKey(source, sessionId);
  // Never downgrade a real upload record into a seed: that would drop the route
  // pin and re-send everything the next time the session is touched.
  if (sent[key] && !sent[key].seeded) return;
  sent[key] = {
    sentAt: new Date().toISOString(),
    totals: normalizeTotals(totals),
    seeded: true,
  };
  saveHookSent(sent);
}

/**
 * Like markTotalsSent, but takes the per-field maximum against what is already
 * recorded instead of overwriting it.
 *
 * The sweep can legitimately meet the same session twice in one run, because an
 * orchestrator may keep a backfilled copy of an agent's session directory
 * alongside the live one (Orca copies ~/.codex/sessions into its runtime home).
 * Those copies can be at different points in the session's life. Overwriting
 * with the older copy's cumulative would move the ledger BACKWARDS, and the
 * next run would re-upload everything in between as a fresh delta.
 *
 * Cumulative session totals never legitimately shrink, so max is always the
 * correct reading. Scoped to the sweep; the direct hooks keep using
 * markTotalsSent, where there is exactly one copy and no ambiguity.
 */
export function markTotalsSentMonotonic(source, sessionId, totals, route) {
  const sent = loadHookSent();
  const key = hookSentKey(source, sessionId);
  const previous = sent[key];
  const prior = normalizeTotals(previous?.seeded ? previous.totals : previous?.totals);
  const next = normalizeTotals(totals);

  sent[key] = {
    sentAt: new Date().toISOString(),
    totals: {
      inputTokens: Math.max(prior.inputTokens, next.inputTokens),
      outputTokens: Math.max(prior.outputTokens, next.outputTokens),
      cacheCreationTokens: Math.max(prior.cacheCreationTokens, next.cacheCreationTokens),
      cacheCreation5mTokens: Math.max(prior.cacheCreation5mTokens, next.cacheCreation5mTokens),
      cacheCreation1hTokens: Math.max(prior.cacheCreation1hTokens, next.cacheCreation1hTokens),
      cacheReadTokens: Math.max(prior.cacheReadTokens, next.cacheReadTokens),
      totalTokens: Math.max(prior.totalTokens, next.totalTokens),
    },
    ...(route ?? previous?.route ? { route: route ?? previous.route } : {}),
  };
  saveHookSent(sent);
}

/**
 * Given the cumulative totals parsed from a session and the totals already
 * uploaded, return the per-field delta (never negative). Used to upload only
 * the tokens accrued since the previous turn.
 */
export function computeDelta(cumulative, alreadySent) {
  const cur = normalizeTotals(cumulative);
  const prev = normalizeTotals(alreadySent);
  const sub = (a, b) => Math.max(0, a - b);
  return {
    inputTokens: sub(cur.inputTokens, prev.inputTokens),
    outputTokens: sub(cur.outputTokens, prev.outputTokens),
    cacheCreationTokens: sub(cur.cacheCreationTokens, prev.cacheCreationTokens),
    cacheCreation5mTokens: sub(cur.cacheCreation5mTokens, prev.cacheCreation5mTokens),
    cacheCreation1hTokens: sub(cur.cacheCreation1hTokens, prev.cacheCreation1hTokens),
    cacheReadTokens: sub(cur.cacheReadTokens, prev.cacheReadTokens),
    totalTokens: sub(cur.totalTokens, prev.totalTokens),
  };
}

// ─── Per-session upload lock ──────────────────────────────────────────────────
//
// With per-turn hooks (Codex notify, Claude Code Stop), two invocations for the
// same session can overlap: the worker for turn N is still uploading (snapshot
// capture and upload retries take seconds) when turn N+1 fires. Both would read
// the same "already sent" totals and upload overlapping deltas — and since every
// upload carries a fresh event_id, the server cannot dedup them. The lock makes
// overlap harmless: the loser exits without uploading, and its tokens are simply
// covered by the next invocation's delta (deltas are cumulative-based, so a
// skipped upload never loses data).
//
// mkdir is the atomic primitive. A crashed holder (SIGKILL, power loss) leaves
// the dir behind; anything older than LOCK_STALE_MS is treated as dead and
// taken over, which is far longer than any legitimate hook run.

const LOCKS_DIR = join(CONFIG_DIR, 'locks');
const LOCK_STALE_MS = 120_000;

function sessionLockDir(source, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return join(LOCKS_DIR, `${source}__${safe}`);
}

export function acquireSessionLock(source, sessionId) {
  const dir = sessionLockDir(source, sessionId);
  try {
    mkdirSync(LOCKS_DIR, { recursive: true });
  } catch {
    return true; // can't manage locks — don't block collection over it
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir); // non-recursive: throws EEXIST when already held
      return true;
    } catch {
      try {
        const age = Date.now() - statSync(dir).mtimeMs;
        if (age < LOCK_STALE_MS) return false;
        rmdirSync(dir); // stale holder — take over on the retry
      } catch {
        return false; // raced with the holder's release/steal; treat as busy
      }
    }
  }
  return false;
}

export function releaseSessionLock(source, sessionId) {
  try {
    rmdirSync(sessionLockDir(source, sessionId));
  } catch {
    /* already gone or stolen — nothing to do */
  }
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function generateEventId() {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}

/**
 * A deterministic event id for a token upload.
 *
 * The server dedups on (user_id, event_id). Because every upload used to carry
 * a fresh random id, it could not — which is exactly what the session-lock
 * comment above says, and why correctness rested entirely on that lock.
 *
 * The id is derived from what uniquely identifies this upload: the session, the
 * calendar day, the watermark it was computed against, and the amounts. Two
 * invocations that read the same ledger and parse the same file necessarily
 * produce the same id, so:
 *
 *   - two hooks racing on one session now collapse into one accepted event and
 *     one `duplicate` server-side, instead of double-counting when the lock is
 *     missed. The lock becomes an optimisation rather than a correctness
 *     requirement.
 *   - a retry after an ambiguous failure (upload landed, ledger write did not)
 *     is safe, because it recomputes the identical id.
 *
 * What it does NOT fix, and is not meant to: a lost or pruned ledger. That
 * changes the watermark, so the recomputed delta is a different upload and
 * legitimately gets a different id. Fixing that would mean uploading one event
 * per turn, which multiplies stored rows for every user — the wrong trade
 * against "store the minimum".
 *
 * @param {string} source
 * @param {string} sessionId
 * @param {{date?: string, inputTokens?: number, outputTokens?: number,
 *          cacheCreationTokens?: number, cacheReadTokens?: number,
 *          totalTokens?: number}} piece the day-slice being uploaded
 * @param {object} alreadySent cumulative totals this delta was computed against
 */
export function deriveEventId(source, sessionId, piece, alreadySent) {
  const sent = normalizeTotals(alreadySent);
  const amounts = [
    piece?.inputTokens,
    piece?.outputTokens,
    piece?.cacheCreationTokens,
    piece?.cacheCreation5mTokens,
    piece?.cacheCreation1hTokens,
    piece?.cacheReadTokens,
    piece?.totalTokens,
  ].map((v) => (Number.isFinite(v) ? Math.floor(v) : 0));

  const material = [
    'v1',
    source,
    sessionId,
    piece?.date ?? '',
    sent.inputTokens,
    sent.outputTokens,
    sent.cacheCreationTokens,
    sent.cacheReadTokens,
    sent.totalTokens,
    ...amounts,
  ].join('|');

  return `evt_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}
