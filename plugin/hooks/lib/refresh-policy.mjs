/**
 * When to refresh, and how the threshold is bounded (hook runtime).
 *
 * Mirror of src/core/refresh-policy.ts — see that file. The hook cannot import
 * the built TypeScript, so the rules live twice. docs/token-refresh.md is the
 * contract.
 */

export const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;
export const REFRESH_THRESHOLD_ENV = 'AGENTBOARD_REFRESH_THRESHOLD_SECONDS';

/**
 * Why a re-login is needed when the stored token cannot rotate at all.
 * Mirrors src/core/refresh-policy.ts — the exact bytes matter, since the CLI
 * keys off this string to word the message correctly.
 */
export const LEGACY_TOKEN_REASON = 'stored token predates refresh support';

/** Seven days. How far ahead a legacy token's expiry is worth mentioning. */
export const DEFAULT_LEGACY_NOTICE_SECONDS = 7 * 24 * 60 * 60;
export const LEGACY_NOTICE_ENV = 'AGENTBOARD_LEGACY_NOTICE_SECONDS';

/**
 * The configured pre-emptive window, in seconds.
 *
 * An env var rather than a constant: verifying rotation needs the server's
 * access TTL at 60s, and a hardcoded 300s would put every freshly minted token
 * already inside the window — so every request would refresh, never exercising
 * the "near expiry" branch and quickly hitting the endpoint's 30/min IP limit.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configuredThresholdSeconds(env = process.env) {
  const raw = env[REFRESH_THRESHOLD_ENV];
  // An empty value means "unset", not zero: `export VAR=` is how a shell clears
  // a variable, and Number("") is 0 — which would disable pre-emptive refresh.
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_THRESHOLD_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REFRESH_THRESHOLD_SECONDS;
  return Math.floor(parsed);
}

/**
 * The threshold actually applied, capped at a third of the token lifetime.
 *
 * A threshold at or above the TTL means "always expiring". The cap degrades a
 * misconfiguration to "refresh near the end" instead of on every request.
 *
 * @param {number|undefined} ttlSeconds
 * @param {number} [configured]
 */
export function effectiveThresholdSeconds(ttlSeconds, configured = configuredThresholdSeconds()) {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return configured;
  }
  return Math.min(configured, Math.floor(ttlSeconds / 3));
}

/**
 * The token's full lifetime from its own claims, or undefined when unknown.
 *
 * @param {{iat?: unknown, exp?: unknown}} claims
 */
export function tokenTtlSeconds(claims) {
  const iat = typeof claims?.iat === 'number' ? claims.iat : undefined;
  const exp = typeof claims?.exp === 'number' ? claims.exp : undefined;
  if (iat === undefined || exp === undefined) return undefined;
  const ttl = exp - iat;
  return ttl > 0 ? ttl : undefined;
}

/**
 * Whether to refresh before the next request. Unknown expiry means no
 * pre-emptive refresh — an opaque token is left to the 401 path.
 *
 * @param {number|undefined} accessExpiresAt unix seconds
 * @param {number} thresholdSeconds
 * @param {number} [nowMs]
 */
export function shouldRefresh(accessExpiresAt, thresholdSeconds, nowMs = Date.now()) {
  if (accessExpiresAt === undefined) return false;
  return Math.floor(nowMs / 1000) >= accessExpiresAt - thresholdSeconds;
}

/**
 * How long before a legacy token expires to start asking for a re-login.
 *
 * Not the access threshold: that is sized for a one-hour token and defaults to
 * five minutes, while a legacy token runs 30 days — warning five minutes ahead
 * would be far too late. No TTL cap either; the cap protects the refresh
 * endpoint, and this path never calls it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function legacyNoticeSeconds(env = process.env) {
  const raw = env[LEGACY_NOTICE_ENV];
  // Empty means unset, not zero — same reading as the access threshold.
  if (raw === undefined || raw.trim() === '') return DEFAULT_LEGACY_NOTICE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LEGACY_NOTICE_SECONDS;
  return Math.floor(parsed);
}

/**
 * Whether a legacy (non-rotatable) token is close enough to expiry to warrant
 * telling the user to log in again. Unknown expiry returns false — no grounds
 * for a warning, and guessing would cry wolf every session.
 *
 * @param {number|undefined} accessExpiresAt unix seconds
 * @param {number} [noticeSeconds]
 * @param {number} [nowMs]
 */
export function isLegacyNoticeDue(
  accessExpiresAt,
  noticeSeconds = legacyNoticeSeconds(),
  nowMs = Date.now(),
) {
  if (accessExpiresAt === undefined) return false;
  return Math.floor(nowMs / 1000) >= accessExpiresAt - noticeSeconds;
}

/**
 * Thirty days. How far ahead of expiry a connected project's credential is
 * renewed. Mirrors src/core/refresh-policy.ts; see "Project credentials" in
 * docs/token-refresh.md.
 */
export const DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS = 30 * 24 * 60 * 60;
export const PROJECT_RENEW_THRESHOLD_ENV = 'AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS';

/** @param {NodeJS.ProcessEnv} [env] */
export function configuredProjectRenewThresholdSeconds(env = process.env) {
  const raw = env[PROJECT_RENEW_THRESHOLD_ENV];
  // Same reading as the access threshold: empty means unset, not zero.
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS;
  return Math.floor(parsed);
}

/**
 * Whether a project credential is inside its renewal window, capped at a third
 * of its lifetime. Unknown expiry means no renewal.
 *
 * @param {{iat?: unknown, exp?: unknown}|null|undefined} claims
 * @param {number} [nowMs]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isProjectRenewalDue(claims, nowMs = Date.now(), env = process.env) {
  const exp = typeof claims?.exp === 'number' ? claims.exp : undefined;
  const threshold = effectiveThresholdSeconds(
    tokenTtlSeconds(claims ?? {}),
    configuredProjectRenewThresholdSeconds(env),
  );
  return shouldRefresh(exp, threshold, nowMs);
}
