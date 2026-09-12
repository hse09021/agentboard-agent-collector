/**
 * When to refresh, and how the threshold is bounded.
 *
 * Split out from the refresh transport so the timing rules can be unit-tested
 * without a server, and so the hook mirror
 * (plugin/hooks/lib/refresh-policy.mjs) has one small surface to match.
 * docs/token-refresh.md is the contract.
 */

export const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;
export const REFRESH_THRESHOLD_ENV = "AGENTBOARD_REFRESH_THRESHOLD_SECONDS";

/**
 * The configured pre-emptive window, in seconds.
 *
 * Verifying rotation end-to-end needs the server's access TTL at 60s. With the
 * threshold hardcoded at 300s, `exp - 300` is already past the moment a token
 * is minted, so EVERY request would refresh: the "only when near expiry" branch
 * would never run, and the unauthenticated refresh endpoint (30 req/min per IP)
 * would start answering 429. Hence an env var.
 */
export function configuredThresholdSeconds(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[REFRESH_THRESHOLD_ENV];
  // An empty value means "unset", not zero: `export VAR=` is how a shell
  // profile clears a variable, and Number("") is 0, which would silently
  // disable pre-emptive refresh entirely.
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REFRESH_THRESHOLD_SECONDS;
  }
  const parsed = Number(raw);
  // A malformed value falls back rather than throwing: a typo in a shell
  // profile must not stop collection.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_REFRESH_THRESHOLD_SECONDS;
  }
  return Math.floor(parsed);
}

/**
 * The threshold actually applied, capped at a third of the token's lifetime.
 *
 * A threshold at or above the TTL means "always expiring", i.e. refresh on
 * every request. The cap makes a misconfiguration degrade to "refresh near the
 * end of the lifetime" instead of hammering the endpoint into a rate limit.
 *
 * @param ttlSeconds the access token's full lifetime, or undefined if unknown
 */
export function effectiveThresholdSeconds(
  ttlSeconds: number | undefined,
  configured = configuredThresholdSeconds()
): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return configured;
  }
  return Math.min(configured, Math.floor(ttlSeconds / 3));
}

/**
 * The token's full lifetime, from the JWT's own claims when available.
 *
 * `iat`/`exp` describe the token as the server minted it, which is what the cap
 * above is about. Falls back to undefined rather than guessing — a caller with
 * no TTL simply applies the configured threshold uncapped.
 */
export function tokenTtlSeconds(claims: {
  iat?: unknown;
  exp?: unknown;
}): number | undefined {
  const iat = typeof claims.iat === "number" ? claims.iat : undefined;
  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  if (iat === undefined || exp === undefined) return undefined;
  const ttl = exp - iat;
  return ttl > 0 ? ttl : undefined;
}

/**
 * Whether the access token should be refreshed before the next request.
 *
 * Unknown expiry means no pre-emptive refresh: an opaque token of unknown
 * lifetime is left to the 401 path rather than refreshed on every call.
 */
export function shouldRefresh(
  accessExpiresAt: number | undefined,
  thresholdSeconds: number,
  nowMs: number = Date.now()
): boolean {
  if (accessExpiresAt === undefined) return false;
  return Math.floor(nowMs / 1000) >= accessExpiresAt - thresholdSeconds;
}
