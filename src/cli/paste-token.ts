/**
 * Parsing what the user pastes at the login prompt.
 *
 * With `v=2` the login page hands out a token PAIR, not a single JWT. One-line
 * JSON is easy to truncate when copying, so the page may also wrap it in
 * base64 — both are accepted here, along with the pre-0.10 bare JWT so that an
 * older server (or an older login page in a browser cache) still works.
 */

import { TokenBundle } from "../platform/credential-store";
import { decodeJwtClaims } from "../core/jwt";

export type PasteResult =
  | { ok: true; bundle: TokenBundle }
  | { ok: false; problem: "empty" | "truncated" | "unrecognized" };

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function bundleFromObject(obj: Record<string, unknown>): TokenBundle | null {
  if (typeof obj.access !== "string" || !obj.access) return null;
  return {
    v: typeof obj.v === "number" ? obj.v : 1,
    access: obj.access,
    access_expires_at:
      num(obj.access_expires_at) ?? num(decodeJwtClaims(obj.access)?.exp),
    refresh: typeof obj.refresh === "string" && obj.refresh ? obj.refresh : null,
    refresh_expires_at: num(obj.refresh_expires_at),
  };
}

/** A bare JWT is exactly three dot-separated base64url segments. */
function looksLikeJwt(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

export function parsePastedToken(input: string): PasteResult {
  const text = input.trim();
  if (!text) return { ok: false, problem: "empty" };

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const bundle = bundleFromObject(parsed as Record<string, unknown>);
        if (bundle) return { ok: true, bundle };
      }
    } catch {
      // Started as JSON but did not parse — almost always a copy that stopped
      // short. Worth saying so precisely, because "paste it again" is the fix.
      return { ok: false, problem: "truncated" };
    }
    return { ok: false, problem: "unrecognized" };
  }

  if (looksLikeJwt(text)) {
    // Legacy single-JWT server, or an older login page. No refresh token: the
    // bundle cannot rotate and expires the old way.
    return {
      ok: true,
      bundle: {
        v: 1,
        access: text,
        access_expires_at: num(decodeJwtClaims(text)?.exp),
        refresh: null,
      },
    };
  }

  // base64-wrapped JSON — the login page may use it because a one-line JSON
  // blob is easy to mangle when copying out of a browser.
  try {
    const decoded = Buffer.from(text, "base64").toString("utf-8").trim();
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const bundle = bundleFromObject(parsed as Record<string, unknown>);
        if (bundle) return { ok: true, bundle };
      }
    }
  } catch {
    /* fall through to unrecognized */
  }

  return { ok: false, problem: "unrecognized" };
}

/** What to tell the user when a paste does not parse. */
export function describePasteProblem(
  problem: Exclude<PasteResult, { ok: true }>["problem"]
): string {
  switch (problem) {
    case "empty":
      return "No token provided. Login cancelled.";
    case "truncated":
      return (
        "That looks like a partial copy — the token starts with '{' but is not " +
        "complete JSON. Select the whole value on the login page and paste it again."
      );
    default:
      return (
        "That does not look like an AgentBoard token. Copy the value shown on " +
        "the login page exactly, with no surrounding quotes or line breaks."
      );
  }
}
