/**
 * How the stored credential is described to the user.
 *
 * Shared by `status` and `doctor` so the two cannot disagree about whether a
 * token is healthy — they used to each decode the JWT themselves, and with
 * rotation there is more to say than "expires in N days": whether renewal is
 * even possible, and when the refresh token itself runs out.
 */

import { TokenBundle } from "../platform/credential-store";
import { decodeJwtClaims } from "./jwt";
import {
  effectiveThresholdSeconds,
  tokenTtlSeconds,
} from "./refresh-policy";

export type CredentialStatus =
  | { kind: "absent" }
  /** Pre-0.10 single JWT: works until it expires, then needs a manual login. */
  | { kind: "legacy"; expiresAt: Date | null; expired: boolean }
  | {
      kind: "rotating";
      accessExpiresAt: Date | null;
      /** When the pre-emptive refresh window opens. */
      renewsAt: Date | null;
      refreshExpiresAt: Date | null;
      accessExpired: boolean;
      refreshExpired: boolean;
    };

function toDate(unixSeconds: number | undefined): Date | null {
  return unixSeconds === undefined ? null : new Date(unixSeconds * 1000);
}

export function describeCredential(
  bundle: TokenBundle | null,
  now: Date = new Date()
): CredentialStatus {
  if (!bundle) return { kind: "absent" };

  const claims = decodeJwtClaims(bundle.access) ?? {};
  const accessExp =
    bundle.access_expires_at ??
    (typeof claims.exp === "number" ? claims.exp : undefined);

  if (!bundle.refresh) {
    const expiresAt = toDate(accessExp);
    return {
      kind: "legacy",
      expiresAt,
      expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
    };
  }

  const threshold = effectiveThresholdSeconds(tokenTtlSeconds(claims));
  const refreshExp = bundle.refresh_expires_at;
  const accessExpiresAt = toDate(accessExp);
  const refreshExpiresAt = toDate(refreshExp);

  return {
    kind: "rotating",
    accessExpiresAt,
    renewsAt: accessExp === undefined ? null : toDate(accessExp - threshold),
    refreshExpiresAt,
    accessExpired:
      accessExpiresAt !== null && accessExpiresAt.getTime() <= now.getTime(),
    refreshExpired:
      refreshExpiresAt !== null && refreshExpiresAt.getTime() <= now.getTime(),
  };
}

function relative(target: Date, now: Date): string {
  const seconds = Math.round((target.getTime() - now.getTime()) / 1000);
  const past = seconds < 0;
  const abs = Math.abs(seconds);

  const value =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86400)}d`;

  return past ? `${value} ago` : `in ${value}`;
}

/** One line for `status`, and the `doctor` check message. */
export function formatCredentialStatus(
  status: CredentialStatus,
  now: Date = new Date()
): string {
  switch (status.kind) {
    case "absent":
      return "Not logged in — run `agentboard login`";

    case "legacy":
      if (status.expired) {
        return "Expired — run `agentboard login` again (no automatic renewal)";
      }
      return status.expiresAt
        ? `Expires ${relative(status.expiresAt, now)} — no automatic renewal, ` +
            "run `agentboard login` to upgrade"
        : "Present (opaque token — expiry unknown, no automatic renewal)";

    case "rotating": {
      if (status.refreshExpired) {
        return "Renewal expired — run `agentboard login` again";
      }
      const parts: string[] = [];
      parts.push(
        status.accessExpiresAt
          ? status.accessExpired
            ? "Access token expired, renews on next use"
            : `Access token expires ${relative(status.accessExpiresAt, now)}`
          : "Access token valid"
      );
      if (status.renewsAt && !status.accessExpired) {
        parts.push(`renews ${relative(status.renewsAt, now)}`);
      }
      if (status.refreshExpiresAt) {
        parts.push(`renewal valid until ${status.refreshExpiresAt.toISOString().slice(0, 10)}`);
      }
      return parts.join(", ");
    }
  }
}

/**
 * Whether `doctor` should call this a failing check.
 *
 * An expired ACCESS token is not a failure when renewal is available — that is
 * the normal state between rotations, and reporting it red would make a healthy
 * install look broken.
 */
export function isCredentialHealthy(status: CredentialStatus): boolean {
  switch (status.kind) {
    case "absent":
      return false;
    case "legacy":
      return !status.expired;
    case "rotating":
      return !status.refreshExpired;
  }
}
