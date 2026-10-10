/**
 * Keeping a connected project's credential alive (hook runtime).
 *
 * `agentboard connect` stores one credential per connected directory. A server
 * that supports rotation issues an access/refresh pair, like the default
 * route's `.token`: the access token lasts about an hour and is rotated through
 * /v1/collector/refresh, and the server detects a refresh token used twice.
 * Older servers, and connections made before rotation, hold a single 90-day
 * credential that renews through /v1/collector/renew — and that same call,
 * sent with `v: 2`, is how such a connection is exchanged for a pair once its
 * server supports one, without the user doing anything.
 *
 * Hooks do this because they are the only code that uploads with these
 * credentials: a machine that is actually used never expires, and one left
 * unused for the whole lifetime does — there is no indefinite bearer.
 *
 * ★ This is a different server's token from `.token`. Nothing here reads or
 *   writes `.token` or `.token.lock`, and token-refresh.mjs never touches a
 *   `.cred`. A token sent to the wrong server is rejected, but by then it has
 *   been shown to that server's operator — so every request here goes to the
 *   route's own api_base_url, and only with that route's own credential.
 *
 * "Project credentials" in docs/token-refresh.md is the contract. The CLI side
 * (src/core/project-credential-status.ts) only reads what this writes.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CONFIG_DIR,
  COLLECTOR_VERSION,
  decodeJwtClaims,
  loadProjectCredential,
  projectCredentialLockPath,
  saveProjectCredential,
} from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { withFileLock } from './token-lock.mjs';
import {
  configuredThresholdSeconds,
  effectiveThresholdSeconds,
  isProjectRenewalDue,
  shouldRefresh,
  tokenTtlSeconds,
} from './refresh-policy.mjs';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long to wait before asking again to exchange a legacy credential, once
 * the server has answered. An old server hands out a fresh 90-day credential
 * on every renew, so asking on every upload would mint one per session; once a
 * day still picks up a server upgrade within a day.
 */
export const UPGRADE_RETRY_MS = 24 * 60 * 60 * 1000;

export const PROJECT_RENEWAL_PATH = join(CONFIG_DIR, 'project-renewal.json');

// ─── Record (project-renewal.json) ────────────────────────────────────────────
//
// {
//   "v": 1,
//   "failures": { "<ref>": { "at", "status"?, "code"?, "token_fp"? } },
//   "upgrades": { "<ref>": { "at", "outcome": "legacy" | "refused" } }
// }
//
// `failures` is what `status` and `doctor` show. `token_fp` marks a failure
// that used up a token — a refused refresh token, or the credential an exchange
// spent when its result could not be saved — so it is never sent again.
// `upgrades` is when a legacy connection last asked to be exchanged for a pair,
// and what came back.

function readRenewalState() {
  try {
    if (!existsSync(PROJECT_RENEWAL_PATH)) return { failures: {}, upgrades: {} };
    const parsed = JSON.parse(readFileSync(PROJECT_RENEWAL_PATH, 'utf-8'));
    const asMap = (v) => (typeof v === 'object' && v !== null ? v : {});
    return { failures: asMap(parsed?.failures), upgrades: asMap(parsed?.upgrades) };
  } catch {
    return { failures: {}, upgrades: {} };
  }
}

export function readProjectRenewalFailures() {
  return readRenewalState().failures;
}

export function readProjectUpgradeAttempts() {
  return readRenewalState().upgrades;
}

/**
 * Applies `change` to the record and writes it back only if it says it changed
 * something. Hooks run on every session end; rewriting an identical record
 * churns a file other hooks are reading, and moving `at` forward would hide how
 * long a refusal has been true.
 *
 * @param {(state: {failures: object, upgrades: object}) => boolean} change
 */
function updateRenewalState(change) {
  try {
    const state = readRenewalState();
    if (!change(state)) return;
    if (Object.keys(state.failures).length === 0 && Object.keys(state.upgrades).length === 0) {
      // Absence is the "nothing wrong" state, as for auth-failure.json.
      if (existsSync(PROJECT_RENEWAL_PATH)) unlinkSync(PROJECT_RENEWAL_PATH);
      return;
    }
    writeJsonAtomic(PROJECT_RENEWAL_PATH, { v: 1, ...state });
  } catch {
    // best-effort: never let bookkeeping break an upload
  }
}

/**
 * Which token a failure used up, without storing the token itself. A spent
 * refresh token must never be sent again — the server reads a second use as
 * theft — and this is how the next hook knows.
 */
function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** The recorded failure that used up `token`, if any. */
function spentFailure(ref, token) {
  const failure = readRenewalState().failures[ref];
  return failure?.token_fp && failure.token_fp === fingerprint(token) ? failure : null;
}

function recordFailure(ref, failure) {
  updateRenewalState((state) => {
    const existing = state.failures[ref];
    if (
      existing &&
      existing.status === failure.status &&
      (existing.code ?? null) === (failure.code ?? null) &&
      (existing.token_fp ?? null) === (failure.token_fp ?? null)
    ) {
      return false;
    }
    state.failures[ref] = {
      at: new Date().toISOString(),
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.token_fp ? { token_fp: failure.token_fp } : {}),
    };
    return true;
  });
}

function recordUpgradeAttempt(ref, outcome, nowMs) {
  updateRenewalState((state) => {
    const existing = state.upgrades[ref];
    if (existing?.outcome === outcome && !upgradeRetryDue(existing, nowMs)) return false;
    state.upgrades[ref] = { at: new Date(nowMs).toISOString(), outcome };
    return true;
  });
}

function clearRecord(ref, { keepUpgrade = false } = {}) {
  updateRenewalState((state) => {
    let changed = false;
    if (ref in state.failures) {
      delete state.failures[ref];
      changed = true;
    }
    if (!keepUpgrade && ref in state.upgrades) {
      delete state.upgrades[ref];
      changed = true;
    }
    return changed;
  });
}

function upgradeRetryDue(attempt, nowMs) {
  const at = Date.parse(attempt?.at ?? '');
  if (!Number.isFinite(at)) return true;
  const age = nowMs - at;
  // A clock that moved backwards must not hold the exchange off indefinitely.
  return age < 0 || age >= UPGRADE_RETRY_MS;
}

function describeRefusal(status, code) {
  if (status === undefined) return code ?? 'refused';
  return `HTTP ${status}${code ? ` ${code}` : ''}`;
}

// ─── Server replies ───────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * Reads a `v: 2` reply into what is stored. Null without an access token —
 * storing that would cut the connection off at the next upload.
 */
function parsePair(body, previousRefresh = null) {
  if (typeof body?.access !== 'string' || !body.access) return null;
  // The server may decline to rotate the refresh token. Dropping it would leave
  // nothing to refresh with, so the previous one is carried forward, as for
  // `.token`.
  const refresh = typeof body.refresh === 'string' && body.refresh ? body.refresh : previousRefresh;
  if (!refresh) return null;
  return {
    v: 2,
    access: body.access,
    access_expires_at: num(body.access_expires_at) ?? num(decodeJwtClaims(body.access)?.exp),
    refresh,
    refresh_expires_at: num(body.refresh_expires_at),
  };
}

async function readCode(response) {
  const body = await response.json().catch(() => null);
  return typeof body?.code === 'string' ? body.code : undefined;
}

async function post(fetchImpl, url, headers, body) {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `agentboard-collector/${COLLECTOR_VERSION}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function endpoint(apiBaseUrl, path) {
  return `${String(apiBaseUrl).replace(/\/+$/, '')}${path}`;
}

/**
 * POST /v1/collector/refresh. Unauthenticated: the refresh token in the body
 * is the credential.
 *
 * 401 `invalid_refresh` (missing, expired, revoked, reused, another device's),
 * 403 `not_a_member` / `revoked_device`, 404 `project_not_found` /
 * `device_not_found`: this refresh token is finished. 429, 5xx, a network
 * failure or a timeout is transient. A 400 is a request this collector got
 * wrong, which a later version may get right, so it is transient too rather
 * than a reason to give up on the connection.
 */
async function postRefresh(apiBaseUrl, refreshToken, deviceId, fetchImpl) {
  let response;
  try {
    response = await post(fetchImpl, endpoint(apiBaseUrl, '/v1/collector/refresh'), {}, {
      refresh_token: refreshToken,
      device_id: deviceId,
    });
  } catch (err) {
    return { kind: 'unavailable', reason: err?.message ?? String(err) };
  }

  if ([401, 403, 404].includes(response.status)) {
    return { kind: 'refused', status: response.status, code: await readCode(response) };
  }
  if (!response.ok) {
    const code = await readCode(response);
    return { kind: 'unavailable', reason: describeRefusal(response.status, code) };
  }

  const pair = parsePair(await response.json().catch(() => null), refreshToken);
  if (!pair) return { kind: 'unavailable', reason: 'refresh response had no access token' };
  return { kind: 'pair', credential: pair };
}

/**
 * POST /v1/collector/renew with the legacy credential as the bearer, asking
 * for a pair (`v: 2`). The reply's shape decides what the server is: a pair
 * means it supports rotation (and has already revoked the credential we sent),
 * a lone `credential` means it ignored `v` and renewed the old way. The
 * server's version is never guessed.
 */
async function postRenew(apiBaseUrl, credential, deviceId, fetchImpl) {
  let response;
  try {
    response = await post(
      fetchImpl,
      endpoint(apiBaseUrl, '/v1/collector/renew'),
      { Authorization: `Bearer ${credential}` },
      { device_id: deviceId, v: 2 },
    );
  } catch (err) {
    return { kind: 'unavailable', reason: err?.message ?? String(err) };
  }

  if ([400, 401, 403, 404].includes(response.status)) {
    return { kind: 'refused', status: response.status, code: await readCode(response) };
  }
  if (!response.ok) return { kind: 'unavailable', reason: `HTTP ${response.status}` };

  const body = await response.json().catch(() => null);
  if (typeof body?.refresh === 'string' && body.refresh) {
    const pair = parsePair(body);
    return pair
      ? { kind: 'pair', credential: pair }
      : { kind: 'unavailable', reason: 'renewal response had no access token' };
  }

  const next = typeof body?.credential === 'string' ? body.credential.trim() : '';
  const exp = decodeJwtClaims(next)?.exp;
  // A 2xx without a usable credential is not something to persist: storing it
  // would cut the connection off at the next upload.
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) {
    return { kind: 'unavailable', reason: 'renewal response had no usable credential' };
  }
  return { kind: 'legacy', credential: next };
}

// ─── Rotation (v: 2) ──────────────────────────────────────────────────────────

/** Same rule as the default route's access token: min(threshold, ttl/3). */
function isAccessRefreshDue(stored, nowMs, env) {
  const claims = decodeJwtClaims(stored.access) ?? {};
  const expiresAt = stored.access_expires_at ?? (typeof claims.exp === 'number' ? claims.exp : undefined);
  return shouldRefresh(
    expiresAt,
    effectiveThresholdSeconds(tokenTtlSeconds(claims), configuredThresholdSeconds(env)),
    nowMs,
  );
}

/**
 * Writes what the server issued, under the connection's lock, unless the file
 * no longer holds the credential that was exchanged. That can only mean the
 * connection was removed (`disconnect`) or replaced mid-flight, and recreating
 * the file would leave a live credential with no connection.
 *
 * `spent` is the token the server invalidated by issuing `next` — the old
 * refresh token, or the legacy credential an exchange revoked. If `next` then
 * cannot be written, this connection stops once the access token in hand
 * expires and only `connect` brings it back, so that is recorded for `status`.
 * With nothing spent (an older server's renewal) the old credential still
 * works, and a failed write loses nothing.
 */
function storeIssued(ref, expected, next, kind, spent) {
  const onDisk = loadProjectCredential(ref);
  if (!onDisk || onDisk.access !== expected.access || onDisk.refresh !== expected.refresh) {
    return { kind: 'superseded', credential: onDisk?.access ?? expected.access };
  }
  try {
    saveProjectCredential(ref, next);
  } catch (err) {
    const reason = err?.message ?? String(err);
    if (!spent) return { kind: 'unavailable', credential: expected.access, reason };
    recordFailure(ref, { code: 'save_failed', token_fp: fingerprint(spent) });
    // The new access token still works for this upload; only later ones are
    // lost.
    return { kind: 'save_failed', credential: next.access, reason };
  }
  return { kind, credential: next.access };
}

async function rotatePair(input, stored, options) {
  const { apiBaseUrl, credentialRef: ref, deviceId } = input;
  const { nowMs, env, fetchImpl, force } = options;

  const spent = spentFailure(ref, stored.refresh);
  if (spent) {
    // Sending a used-up refresh token again would only repeat the reuse
    // detection. The access token in hand is used until it expires.
    return { kind: 'refused', credential: stored.access, reason: describeRefusal(spent.status, spent.code) };
  }
  if (stored.refresh_expires_at !== undefined && stored.refresh_expires_at * 1000 <= nowMs) {
    return { kind: 'expired', credential: stored.access };
  }
  // An expired access token is still refreshed: the refresh token is what has
  // to be alive, unlike a legacy credential, which renews only itself.
  if (!force && !isAccessRefreshDue(stored, nowMs, env)) {
    return { kind: 'current', credential: stored.access };
  }

  const lockPath = projectCredentialLockPath(ref);
  return withFileLock(
    lockPath,
    async () => {
      // Re-read inside the lock: the previous holder may have just rotated, and
      // re-submitting the refresh token it spent would burn the family.
      const current = loadProjectCredential(ref);
      if (!current || current.refresh !== stored.refresh) {
        return { kind: 'superseded', credential: current?.access ?? stored.access };
      }

      const outcome = await postRefresh(apiBaseUrl, current.refresh, deviceId, fetchImpl);
      if (outcome.kind === 'refused') {
        recordFailure(ref, {
          status: outcome.status,
          code: outcome.code,
          token_fp: fingerprint(current.refresh),
        });
        return {
          kind: 'refused',
          credential: current.access,
          reason: describeRefusal(outcome.status, outcome.code),
        };
      }
      if (outcome.kind === 'unavailable') {
        return { kind: 'unavailable', credential: current.access, reason: outcome.reason };
      }

      const result = storeIssued(ref, current, outcome.credential, 'refreshed', current.refresh);
      if (result.kind === 'refreshed') clearRecord(ref);
      return result;
    },
    // Busy: the holder is mid-rotation. Re-read rather than queue behind it.
    () => {
      const current = loadProjectCredential(ref);
      return current && current.refresh !== stored.refresh
        ? { kind: 'superseded', credential: current.access }
        : { kind: 'unavailable', credential: stored.access, reason: 'another process holds the refresh lock' };
    },
  );
}

// ─── Legacy credential ────────────────────────────────────────────────────────

async function renewLegacy(input, stored, options) {
  const { apiBaseUrl, credentialRef: ref, deviceId } = input;
  const { nowMs, env, fetchImpl, force } = options;
  const credential = stored.access;
  const claims = decodeJwtClaims(credential);

  if (typeof claims?.exp === 'number' && claims.exp * 1000 <= nowMs) {
    // The server renews only a credential that is still valid. Sending this
    // could only fail; `status` tells the user to connect again.
    return { kind: 'expired', credential };
  }
  // After a 401 the server has just refused this credential, and renew is
  // refused for the same reason. Only a pair can recover from a 401.
  if (force) return { kind: 'current', credential };

  const spent = spentFailure(ref, credential);
  if (spent) {
    // An exchange already revoked this credential and its pair was lost.
    return { kind: 'refused', credential, reason: describeRefusal(spent.status, spent.code) };
  }

  // Exchanged at the first upload rather than in the last 30 days, so existing
  // connections move to rotation without anyone running `connect` again. Once
  // the server has answered, ask at most once a day — unless the old renewal
  // window says it is time, which keeps an old server's credential alive
  // exactly as before.
  const lastAttempt = readRenewalState().upgrades[ref];
  const due = !lastAttempt || upgradeRetryDue(lastAttempt, nowMs) || isProjectRenewalDue(claims, nowMs, env);
  if (!due) return { kind: 'current', credential };

  return withFileLock(
    projectCredentialLockPath(ref),
    async () => {
      const current = loadProjectCredential(ref);
      if (!current || current.refresh !== null || current.access !== credential) {
        return { kind: 'superseded', credential: current?.access ?? credential };
      }

      const outcome = await postRenew(apiBaseUrl, credential, deviceId, fetchImpl);

      if (outcome.kind === 'refused') {
        recordFailure(ref, { status: outcome.status, code: outcome.code });
        recordUpgradeAttempt(ref, 'refused', nowMs);
        return { kind: 'refused', credential, reason: describeRefusal(outcome.status, outcome.code) };
      }
      if (outcome.kind === 'unavailable') return { kind: 'unavailable', credential, reason: outcome.reason };

      if (outcome.kind === 'pair') {
        // ★ The server revoked the credential we sent the moment it issued
        //   this pair. Failing to keep the pair ends the connection, and
        //   storeIssued records that so `status` can say so.
        const result = storeIssued(ref, current, outcome.credential, 'upgraded', credential);
        if (result.kind === 'upgraded') clearRecord(ref);
        return result;
      }

      // An older server: it renewed the credential the old way. Keep the new
      // one — the old one also stays valid there — and wait a day to ask again.
      recordUpgradeAttempt(ref, 'legacy', nowMs);
      const result = storeIssued(ref, current, { v: 1, access: outcome.credential, refresh: null }, 'renewed', null);
      if (result.kind === 'renewed') clearRecord(ref, { keepUpgrade: true });
      return result;
    },
    () => {
      const current = loadProjectCredential(ref);
      return current && current.access !== credential
        ? { kind: 'superseded', credential: current.access }
        : { kind: 'unavailable', credential, reason: 'another process holds the renewal lock' };
    },
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Returns the credential to upload with, rotating or renewing it first when
 * due. Never throws, and never blocks an upload: on any problem the credential
 * in hand is returned, since it may still work.
 *
 * `force` is the post-401 path: rotate a pair regardless of its expiry. The
 * caller retries the upload at most once with what comes back.
 *
 * @param {{apiBaseUrl: string, credentialRef: string, credential?: string, deviceId: string}} input
 * @param {{fetchImpl?: typeof fetch, nowMs?: number, env?: NodeJS.ProcessEnv, force?: boolean}} [options]
 * @returns {Promise<{kind: 'current'|'refreshed'|'upgraded'|'renewed'|'superseded'|'expired'
 *                          |'refused'|'save_failed'|'unavailable',
 *                    credential: string, reason?: string}>}
 */
export async function ensureFreshProjectCredential(input, options = {}) {
  const resolved = {
    nowMs: options.nowMs ?? Date.now(),
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
    force: options.force === true,
  };
  const stored = loadProjectCredential(input.credentialRef);
  const credential = stored?.access ?? input.credential;

  try {
    if (!stored || !input.deviceId) return { kind: 'current', credential };
    return stored.refresh
      ? await rotatePair(input, stored, resolved)
      : await renewLegacy(input, stored, resolved);
  } catch (err) {
    return { kind: 'unavailable', credential, reason: err?.message ?? String(err) };
  }
}
