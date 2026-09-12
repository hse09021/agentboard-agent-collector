/**
 * Access-token rotation for hooks.
 *
 * Mirror of src/api/token-refresh.ts. The hook runs in the background with no
 * stdout anyone reads, so the failure paths differ in one way: a refresh token
 * the server rejects is recorded to disk (auth-failure.mjs) for the next CLI
 * run to surface, instead of being printed. docs/token-refresh.md is the
 * contract for everything else.
 */

import { loadTokenBundle, saveTokenBundle, decodeJwtClaims } from './config.mjs';
import { withTokenLock } from './token-lock.mjs';
import {
  effectiveThresholdSeconds,
  isLegacyNoticeDue,
  LEGACY_TOKEN_REASON,
  shouldRefresh,
  tokenTtlSeconds,
} from './refresh-policy.mjs';

const REFRESH_TIMEOUT_MS = 15_000;

// Re-exported for callers (and tests) that compare against the reason.
export { LEGACY_TOKEN_REASON };

function refreshUrl(apiBaseUrl) {
  return `${String(apiBaseUrl).replace(/\/$/, '')}/v1/auth/token/refresh`;
}

/**
 * Reads the server's reply into a bundle. A 2xx without an `access` field is a
 * failure, not something to persist — storing an empty access token would lock
 * the user out until they logged in again.
 */
export function parseRefreshResponse(body) {
  if (typeof body !== 'object' || body === null) return null;
  if (typeof body.access !== 'string' || !body.access) return null;

  const num = (v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

  return {
    v: typeof body.v === 'number' ? body.v : 1,
    access: body.access,
    access_expires_at: num(body.access_expires_at) ?? num(decodeJwtClaims(body.access)?.exp),
    refresh: typeof body.refresh === 'string' && body.refresh ? body.refresh : null,
    refresh_expires_at: num(body.refresh_expires_at),
  };
}

/**
 * Whether this bundle is due for a pre-emptive refresh.
 *
 * @param {{access: string, access_expires_at?: number, refresh: string|null}} bundle
 * @param {number} [nowMs]
 */
/**
 * A legacy token's expiry, from the bundle or the JWT claim. Undefined when
 * neither is readable — the caller then stays silent.
 *
 * @param {{access: string, access_expires_at?: number}} bundle
 */
function legacyExpiresAt(bundle) {
  if (bundle?.access_expires_at !== undefined) return bundle.access_expires_at;
  const exp = decodeJwtClaims(bundle?.access)?.exp;
  return typeof exp === 'number' ? exp : undefined;
}

export function isDueForRefresh(bundle, nowMs = Date.now()) {
  if (!bundle?.refresh) return false; // legacy token — nothing to rotate with
  const claims = decodeJwtClaims(bundle.access) ?? {};
  const expiresAt = bundle.access_expires_at ?? claims.exp;
  return shouldRefresh(
    typeof expiresAt === 'number' ? expiresAt : undefined,
    effectiveThresholdSeconds(tokenTtlSeconds(claims)),
    nowMs,
  );
}

async function postRefresh(apiBaseUrl, refreshToken) {
  let response;
  try {
    response = await fetch(refreshUrl(apiBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    // Offline or timed out. The current access token may still be good, so
    // this must not read as "logged out".
    return { kind: 'unavailable', reason: err?.message ?? String(err) };
  }

  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => '');
    return { kind: 'reauth_required', reason: text || `HTTP ${response.status}` };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { kind: 'unavailable', reason: `HTTP ${response.status}: ${text}` };
  }

  const body = await response.json().catch(() => null);
  const bundle = parseRefreshResponse(body);
  if (!bundle) return { kind: 'unavailable', reason: 'refresh response had no access token' };

  // The server may decline to rotate the refresh token. Dropping it would
  // leave us unable to refresh ever again, so carry the old one forward.
  if (!bundle.refresh) bundle.refresh = refreshToken;

  saveTokenBundle(bundle);
  return { kind: 'refreshed', bundle };
}

/**
 * Ensures a usable access token for the DEFAULT route, rotating if it is close
 * to expiry.
 *
 * Only ever called for the default route: a per-project `.cred` is a separate
 * enrollment credential the server does not rotate.
 *
 * @param {string} apiBaseUrl
 * @param {{force?: boolean, nowMs?: number}} [options]
 * @returns {Promise<{kind:'refreshed'|'current', bundle: object}
 *                 | {kind:'reauth_required'|'unavailable', reason: string}>}
 */
export async function ensureFreshToken(apiBaseUrl, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const bundle = loadTokenBundle();
  if (!bundle) return { kind: 'reauth_required', reason: 'not logged in' };

  // ★ Legacy tokens are checked BEFORE the not-due early return below.
  //
  // isDueForRefresh() answers false for a legacy bundle — nothing to rotate
  // with — so this branch used to sit after it and was unreachable without
  // `force`, which hooks never pass. The effect was that a hook treated an
  // unrotatable token as healthy until it expired and uploads began failing
  // with a 401 that, on this path, nobody ever sees.
  if (!bundle.refresh) {
    // `force` is the post-401 path: the server just refused this token, so its
    // printed expiry is beside the point. Otherwise speak up only once expiry
    // is close — the token still works until then, and warning a user whose
    // collection is fine reads as a bug rather than a notice.
    if (options.force || isLegacyNoticeDue(legacyExpiresAt(bundle), undefined, nowMs)) {
      return { kind: 'reauth_required', reason: LEGACY_TOKEN_REASON };
    }
    return { kind: 'current', bundle };
  }

  if (!options.force && !isDueForRefresh(bundle, nowMs)) {
    return { kind: 'current', bundle };
  }

  return withTokenLock(
    async () => {
      // Re-read inside the lock: the previous holder may have just written a
      // fresh pair, and re-submitting the old refresh token would look like
      // replay and burn the whole family.
      const current = loadTokenBundle();
      if (!current) return { kind: 'reauth_required', reason: 'token disappeared' };
      if (current.refresh !== bundle.refresh) return { kind: 'refreshed', bundle: current };
      if (!options.force && !isDueForRefresh(current, Date.now())) {
        return { kind: 'current', bundle: current };
      }
      return postRefresh(apiBaseUrl, current.refresh);
    },
    // Busy: the holder is mid-refresh. Re-read instead of queueing behind it.
    () => {
      const current = loadTokenBundle();
      if (!current) return { kind: 'reauth_required', reason: 'token disappeared' };
      return current.refresh !== bundle.refresh || !isDueForRefresh(current, Date.now())
        ? { kind: 'refreshed', bundle: current }
        : { kind: 'unavailable', reason: 'another process holds the refresh lock' };
    },
  );
}
