/**
 * Access-token rotation for the CLI.
 *
 * The default route's credential is a short-lived access token plus an opaque
 * refresh token. Before a request goes out, an access token close to expiry is
 * exchanged for a fresh pair; a 401 that slips through triggers exactly one
 * retry. See docs/token-refresh.md — the hook path implements the same
 * behaviour in plugin/hooks/lib/token-refresh.mjs and must stay in step.
 */

import {
  TokenBundle,
  loadTokenBundle,
  saveTokenBundle,
} from "../platform/credential-store";
import { withTokenLock } from "../platform/token-lock";
import { decodeJwtClaims } from "../core/jwt";
import {
  effectiveThresholdSeconds,
  isLegacyNoticeDue,
  LEGACY_TOKEN_REASON,
  shouldRefresh,
  tokenTtlSeconds,
} from "../core/refresh-policy";

const REFRESH_TIMEOUT_MS = 15_000;

// Re-exported so callers of this module do not need to reach into the policy
// module for the one string they might compare against.
export { LEGACY_TOKEN_REASON };

export type RefreshOutcome =
  /** A newer bundle is in hand (rotated here, or written by another process). */
  | { kind: "refreshed"; bundle: TokenBundle }
  /** Nothing to do — the access token is still comfortably valid. */
  | { kind: "current"; bundle: TokenBundle }
  /** The refresh token itself was rejected. Only re-login fixes this. */
  | { kind: "reauth_required"; reason: string }
  /** Transient (5xx, network, timeout). Keep using what we have. */
  | { kind: "unavailable"; reason: string };

/**
 * The refresh endpoint lives next to the rest of the v1 API.
 *
 * ★ 요청 본문의 키는 `refresh_token` 이고, 응답의 키는 `refresh` 다. 이름이
 *   다르다는 사실이 이 파일의 유일한 함정이다 — 응답만 보고 요청도 `refresh`
 *   일 것이라 넘겨짚으면 서버가 400(ZodError) 을 돌려주는데, 400 은 아래에서
 *   `unavailable`(일시적 오류) 로 분류되어 조용히 삼켜진다. 그래서 로테이션이
 *   한 번도 돌지 않는데 아무 에러도 보이지 않는 상태가 된다.
 *   서버 스키마: api/src/modules/auth/routes/token.ts 의 bodySchema.
 */
function refreshUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/v1/auth/token/refresh`;
}

function revokeUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/v1/auth/token/revoke`;
}

/**
 * Reads the server's reply into a bundle.
 *
 * A 2xx whose body is missing `access` is treated as a failure rather than
 * being persisted: writing a bundle with an empty access token would lock the
 * user out until they logged in again.
 */
export function parseRefreshResponse(body: unknown): TokenBundle | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.access !== "string" || !obj.access) return null;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? Math.floor(v)
      : undefined;

  return {
    v: typeof obj.v === "number" ? obj.v : 1,
    access: obj.access,
    access_expires_at:
      num(obj.access_expires_at) ?? num(decodeJwtClaims(obj.access)?.exp),
    refresh: typeof obj.refresh === "string" && obj.refresh ? obj.refresh : null,
    refresh_expires_at: num(obj.refresh_expires_at),
  };
}

/**
 * A legacy token's expiry, from the bundle or the JWT's own claim.
 *
 * Undefined when neither is readable, which the caller treats as "say
 * nothing" — an opaque token of unknown lifetime gives no grounds to warn.
 */
function legacyExpiresAt(bundle: TokenBundle): number | undefined {
  if (bundle.access_expires_at !== undefined) return bundle.access_expires_at;
  const exp = decodeJwtClaims(bundle.access)?.exp;
  return typeof exp === "number" ? exp : undefined;
}

/** Whether this bundle is due for a pre-emptive refresh. */
export function isDueForRefresh(
  bundle: TokenBundle,
  nowMs: number = Date.now()
): boolean {
  if (!bundle.refresh) return false; // legacy token — nothing to rotate with
  const claims = decodeJwtClaims(bundle.access) ?? {};
  const ttl = tokenTtlSeconds(claims);
  const expiresAt = bundle.access_expires_at ?? claims.exp;
  return shouldRefresh(
    typeof expiresAt === "number" ? expiresAt : undefined,
    effectiveThresholdSeconds(ttl),
    nowMs
  );
}

async function postRefresh(
  apiBaseUrl: string,
  refreshToken: string
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(refreshUrl(apiBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    // Offline, DNS failure, timeout. The current access token may well still
    // work, so this must not read as "logged out".
    return {
      kind: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => "");
    return {
      kind: "reauth_required",
      reason: text || `HTTP ${response.status}`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { kind: "unavailable", reason: `HTTP ${response.status}: ${text}` };
  }

  const body = await response.json().catch(() => null);
  const bundle = parseRefreshResponse(body);
  if (!bundle) {
    return { kind: "unavailable", reason: "refresh response had no access token" };
  }

  // The server may omit `refresh` when it chooses not to rotate the refresh
  // token. Dropping it would leave us unable to refresh ever again, so carry
  // the existing one forward.
  if (!bundle.refresh) bundle.refresh = refreshToken;

  saveTokenBundle(bundle);
  return { kind: "refreshed", bundle };
}

/**
 * Ensures a usable access token, rotating if it is close to expiry.
 *
 * `force` is the post-401 path: refresh even though the local clock says there
 * is time left (a skewed clock, or a token the server invalidated early).
 */
export async function ensureFreshToken(
  apiBaseUrl: string,
  options: { force?: boolean; nowMs?: number } = {}
): Promise<RefreshOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  const bundle = loadTokenBundle();
  if (!bundle) return { kind: "reauth_required", reason: "not logged in" };

  // ★ Legacy tokens are checked BEFORE the not-due early return below.
  //
  // isDueForRefresh() answers false for a legacy bundle — correctly, since
  // there is nothing to rotate with — so putting this check after it left the
  // branch unreachable outside the force path, and a hook (which never forces)
  // treated an unrotatable token as a healthy one right up until it expired
  // and uploads started failing with a 401 nobody reads.
  if (!bundle.refresh) {
    // `force` is the post-401 path: the server has just refused this token, so
    // its printed expiry is beside the point — there is no way to recover it.
    // Otherwise speak up only once expiry is actually close; the token works
    // until then, and demanding a re-login from someone whose collection is
    // fine reads as a bug rather than a warning.
    if (options.force || isLegacyNoticeDue(legacyExpiresAt(bundle), undefined, nowMs)) {
      return { kind: "reauth_required", reason: LEGACY_TOKEN_REASON };
    }
    return { kind: "current", bundle };
  }

  if (!options.force && !isDueForRefresh(bundle, nowMs)) {
    return { kind: "current", bundle };
  }

  return withTokenLock(
    async () => {
      // Re-read inside the lock: whoever held it before us may have just
      // written a fresh pair, and submitting the old refresh token now would
      // look like replay and burn the family.
      const current = loadTokenBundle();
      if (!current) return { kind: "reauth_required", reason: "token disappeared" };
      if (current.refresh !== bundle.refresh) {
        return { kind: "refreshed", bundle: current };
      }
      if (!options.force && !isDueForRefresh(current, Date.now())) {
        return { kind: "current", bundle: current };
      }
      return postRefresh(apiBaseUrl, current.refresh!);
    },
    // Busy: the holder is mid-refresh. Re-read rather than queueing behind it.
    () => {
      const current = loadTokenBundle();
      if (!current) return { kind: "reauth_required", reason: "token disappeared" };
      return current.refresh !== bundle.refresh || !isDueForRefresh(current, Date.now())
        ? { kind: "refreshed", bundle: current }
        : { kind: "unavailable", reason: "another process holds the refresh lock" };
    }
  );
}

/**
 * Asks the server to revoke the refresh token (and its family).
 *
 * Never throws: `logout` must delete local state whether or not the server can
 * be reached.
 */
export async function revokeRefreshToken(
  apiBaseUrl: string,
  refreshToken: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const response = await fetch(revokeUrl(apiBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    // 401/404 means the server already considers it gone — that is the state
    // logout wants, so it is a success from the caller's point of view.
    if (response.ok || response.status === 401 || response.status === 404) {
      return { ok: true };
    }
    return { ok: false, reason: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
