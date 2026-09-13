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
 * Why a re-login is needed when the stored token cannot rotate at all.
 *
 * Lives here because three places must agree on the exact bytes: the CLI and
 * hook refresh paths that produce it, and the CLI display code that keys off it
 * to avoid calling a legacy token a failed renewal. Mirrored in
 * plugin/hooks/lib/refresh-policy.mjs.
 */
export const LEGACY_TOKEN_REASON = "stored token predates refresh support";

/** Seven days. How far ahead a legacy token's expiry is worth mentioning. */
export const DEFAULT_LEGACY_NOTICE_SECONDS = 7 * 24 * 60 * 60;
export const LEGACY_NOTICE_ENV = "AGENTBOARD_LEGACY_NOTICE_SECONDS";

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

/**
 * How long before a legacy token expires to start asking for a re-login.
 *
 * Deliberately not the access threshold. That one is sized for a one-hour
 * access token and defaults to five minutes; a legacy token runs for 30 days,
 * so reusing it would warn five minutes before collection breaks — far too
 * late to be useful. A week gives the user room to act.
 *
 * No TTL cap either. The cap on the access threshold stops a misconfigured
 * value from refreshing on every request; nothing here calls the server, so
 * there is no request to protect.
 */
export function legacyNoticeSeconds(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[LEGACY_NOTICE_ENV];
  // Same reading as the access threshold: empty means unset, not zero.
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_LEGACY_NOTICE_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LEGACY_NOTICE_SECONDS;
  }
  return Math.floor(parsed);
}

/**
 * Whether a legacy (non-rotatable) token is close enough to expiry to warrant
 * telling the user to log in again.
 *
 * Unknown expiry returns false: a token whose lifetime cannot be read gives no
 * grounds for a warning, and guessing would cry wolf on every session.
 */
export function isLegacyNoticeDue(
  accessExpiresAt: number | undefined,
  noticeSeconds: number = legacyNoticeSeconds(),
  nowMs: number = Date.now()
): boolean {
  if (accessExpiresAt === undefined) return false;
  return Math.floor(nowMs / 1000) >= accessExpiresAt - noticeSeconds;
}

/**
 * Thirty days. How far ahead of expiry a connected project's credential is
 * renewed. With the server's default 90-day lifetime this equals the ttl/3
 * cap, so a machine used at least once a month never sees its connection
 * expire. See "Project credentials" in docs/token-refresh.md.
 */
export const DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS = 30 * 24 * 60 * 60;
export const PROJECT_RENEW_THRESHOLD_ENV = "AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS";

export function configuredProjectRenewThresholdSeconds(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[PROJECT_RENEW_THRESHOLD_ENV];
  // Same reading as the access threshold: empty means unset, not zero.
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PROJECT_RENEW_THRESHOLD_SECONDS;
  }
  return Math.floor(parsed);
}

/**
 * Whether a project credential is inside its renewal window.
 *
 * Capped at a third of the lifetime, like the access threshold: verifying
 * renewal means shortening the server TTL, and an uncapped 30-day window would
 * then renew on every upload. Unknown expiry means no renewal.
 */
export function isProjectRenewalDue(
  claims: { iat?: unknown; exp?: unknown } | null | undefined,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const exp = typeof claims?.exp === "number" ? claims.exp : undefined;
  const threshold = effectiveThresholdSeconds(
    tokenTtlSeconds(claims ?? {}),
    configuredProjectRenewThresholdSeconds(env)
  );
  return shouldRefresh(exp, threshold, nowMs);
}
