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
  writeFileSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const COLLECTOR_VERSION = '0.4.0';
export const DEFAULT_API_URL = process.env.AGENTBOARD_API_URL ?? 'https://agentboard.kro.kr/api/proxy';

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function getConfigDir() {
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
      config.api_base_url = stripTrailingSlash(config.api_base_url);
    }
    return config;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(config) {
  return stripTrailingSlash(config?.api_base_url ?? DEFAULT_API_URL);
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
    writeFileSync(HOOK_SENT_PATH, JSON.stringify(sent, null, 2) + '\n', { mode: 0o600 });
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

const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
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
 * Persist the cumulative token totals uploaded so far for a session.
 */
export function markTotalsSent(source, sessionId, totals) {
  const sent = loadHookSent();
  sent[hookSentKey(source, sessionId)] = {
    sentAt: new Date().toISOString(),
    totals: normalizeTotals(totals),
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
