/**
 * JWT decoding — claims only, no signature verification.
 *
 * The collector cannot verify these tokens: it does not have the signing
 * secret, and the servers that issue them each have their own. Decoding is
 * still useful for two things it can do locally:
 *
 *   1. Tell the user their credential expired, instead of uploads failing
 *      silently forever. `doctor` used to check only that the token FILE
 *      existed, so an expired token showed every check green.
 *   2. Read where an enrollment ticket wants to send data, so `connect` can
 *      show the user that address before anything is saved.
 *
 * Nothing here is a security boundary. The server verifies the signature; this
 * only decides what to display and when to warn.
 */

export interface JwtClaims {
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  sub?: string;
  typ?: string;
  /** Enrollment ticket: API base URL of the issuing server. */
  api?: string;
  /** Project scope. The server maps this to a workspace key on ingest. */
  prj?: string;
  jti?: string;
  [key: string]: unknown;
}

function decodeBase64Url(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Returns null for anything that is not a readable JWT — an opaque token is not an error. */
export function decodeJwtClaims(token: string | null | undefined): JwtClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const json = decodeBase64Url(parts[1]);
  if (!json) return null;

  try {
    const claims = JSON.parse(json) as unknown;
    return typeof claims === "object" && claims !== null ? (claims as JwtClaims) : null;
  } catch {
    return null;
  }
}

export type TokenStatus =
  | { kind: "valid"; expiresAt: Date; daysLeft: number }
  | { kind: "expiring"; expiresAt: Date; daysLeft: number }
  | { kind: "expired"; expiresAt: Date }
  | { kind: "unknown" };

const EXPIRY_WARNING_DAYS = 7;

export function describeTokenExpiry(
  token: string | null | undefined,
  now: Date = new Date()
): TokenStatus {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== "number") return { kind: "unknown" };

  const expiresAt = new Date(claims.exp * 1000);
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return { kind: "expired", expiresAt };

  const daysLeft = Math.floor(msLeft / 86_400_000);
  return daysLeft <= EXPIRY_WARNING_DAYS
    ? { kind: "expiring", expiresAt, daysLeft }
    : { kind: "valid", expiresAt, daysLeft };
}

/** Host of a URL, or null. Used to compare a token's issuer against a server. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
