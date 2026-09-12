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
