import * as fs from "fs";
import * as path from "path";
import { getTokenPath, getConfigDir, ensureConfigDir } from "../core/config";
import { decodeJwtClaims } from "../core/jwt";
import { releaseFileLock, releaseTokenLock } from "./token-lock";

/**
 * Per-route credentials.
 *
 * The community server keeps using .token (written by `agentboard login`).
 * Every connected project gets its own file under credentials/, because its
 * credential is scoped to one project on one server — losing or revoking one
 * must not touch the others, and none of them may ever reach another server.
 *
 * Separate files rather than one JSON blob: deleteCredential() overwrites the
 * bytes before unlinking, and that is impossible to do for a single entry
 * inside a shared document. A corrupt file also costs one route instead of all
 * of them.
 */

const CREDENTIAL_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function getCredentialsDir(): string {
  return path.join(getConfigDir(), "credentials");
}

/**
 * Refs become filenames, so they are validated rather than sanitized — a ref
 * that does not match is a bug in the caller, not something to paper over.
 */
export function assertValidCredentialRef(ref: string): void {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid credential ref: ${JSON.stringify(ref)}`);
  }
}

export function getCredentialPath(ref: string): string {
  assertValidCredentialRef(ref);
  return path.join(getCredentialsDir(), `${ref}.cred`);
}

/**
 * The lock hooks take while rotating this connection's credential. One per
 * connection: different connections belong to different refresh families, so
 * they never need to wait for each other.
 */
export function getCredentialLockPath(ref: string): string {
  assertValidCredentialRef(ref);
  return path.join(getCredentialsDir(), `${ref}.lock`);
}

/**
 * A connected project's credential.
 *
 * A server that supports rotation issues an access/refresh pair (`v: 2`),
 * stored as JSON. Older servers, and connections made before rotation, hold a
 * single 90-day JWT; it is promoted in memory to `refresh: null`, so callers
 * handle one shape. See "Project credentials" in docs/token-refresh.md.
 *
 * Deliberately not TokenBundle. That is the default route's `.token`, issued by
 * a different server, and one type for both would make it easy to hand one
 * server's token to the other's refresh code.
 */
export interface ProjectCredential {
  /** 2 for a pair; 1 for a legacy single JWT promoted in memory. */
  v: number;
  /** The bearer for uploads: the access token, or the legacy credential. */
  access: string;
  /** Unix seconds. */
  access_expires_at?: number;
  /** Null for a legacy credential, which renews through /v1/collector/renew. */
  refresh: string | null;
  /** Unix seconds. Absent when the server does not report it. */
  refresh_expires_at?: number;
}

export const PROJECT_CREDENTIAL_FORMAT_VERSION = 2;

/**
 * Parses either storage format, with the same discriminator as
 * parseTokenFile(): a leading `{` is the JSON pair, anything else a legacy
 * JWT. A pair without both tokens is unusable rather than legacy — an access
 * token alone dies within the hour and cannot be renewed — so it reads as no
 * credential, which tells the user to connect again.
 */
export function parseProjectCredentialFile(contents: string): ProjectCredential | null {
  const trimmed = contents.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("{")) {
    return {
      v: 1,
      access: trimmed,
      access_expires_at: coerceUnixSeconds(decodeJwtClaims(trimmed)?.exp),
      refresh: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access !== "string" || !obj.access) return null;
  if (typeof obj.refresh !== "string" || !obj.refresh) return null;

  return {
    v: typeof obj.v === "number" ? obj.v : PROJECT_CREDENTIAL_FORMAT_VERSION,
    access: obj.access,
    access_expires_at:
      coerceUnixSeconds(obj.access_expires_at) ?? coerceUnixSeconds(decodeJwtClaims(obj.access)?.exp),
    refresh: obj.refresh,
    refresh_expires_at: coerceUnixSeconds(obj.refresh_expires_at),
  };
}

/**
 * A legacy credential is written back as the bare JWT it was, so a collector
 * that predates the pair format can still read it.
 */
export function serializeProjectCredential(credential: ProjectCredential): string {
  if (!credential.refresh) return credential.access;
  return JSON.stringify(
    {
      v: credential.v ?? PROJECT_CREDENTIAL_FORMAT_VERSION,
      access: credential.access,
      ...(credential.access_expires_at !== undefined
        ? { access_expires_at: credential.access_expires_at }
        : {}),
      refresh: credential.refresh,
      ...(credential.refresh_expires_at !== undefined
        ? { refresh_expires_at: credential.refresh_expires_at }
        : {}),
    },
    null,
    2
  );
}

/**
 * Writes atomically (temp file + rename), mode 0600. Hooks read this file while
 * other hooks rotate it, and a truncated read would look like a missing
 * credential and skip the upload.
 *
 * Accepts a bare legacy credential (what an older server's enroll returns) or
 * a pair.
 */
export function saveCredential(ref: string, credential: string | ProjectCredential): void {
  const target = getCredentialPath(ref);
  fs.mkdirSync(getCredentialsDir(), { recursive: true, mode: 0o700 });
  const contents = typeof credential === "string" ? credential : serializeProjectCredential(credential);
  writeSecretAtomic(target, contents);
}

export function loadProjectCredential(ref: string): ProjectCredential | null {
  let target: string;
  try {
    target = getCredentialPath(ref);
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  try {
    return parseProjectCredentialFile(fs.readFileSync(target, "utf-8"));
  } catch {
    return null;
  }
}

/** The bearer this connection uploads with, in either storage format. */
export function loadCredential(ref: string): string | null {
  return loadProjectCredential(ref)?.access ?? null;
}

/** Overwrites the bytes before unlinking, same as deleteToken(). */
export function deleteCredential(ref: string): void {
  let target: string;
  try {
    target = getCredentialPath(ref);
  } catch {
    return;
  }
  // Like deleteToken(): a lock left by a killed hook would otherwise outlive
  // the connection it guarded.
  releaseFileLock(getCredentialLockPath(ref));
  if (!fs.existsSync(target)) return;
  try {
    const len = fs.statSync(target).size;
    if (len > 0) fs.writeFileSync(target, Buffer.alloc(len, 0));
    fs.unlinkSync(target);
  } catch {
    // best-effort
  }
}

export function listCredentialRefs(): string[] {
  const dir = getCredentialsDir();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".cred"))
      .map((f) => f.slice(0, -".cred".length));
  } catch {
    return [];
  }
}

/**
 * The stored credential for the default route.
 *
 * `access` is the bearer token; `refresh` is the opaque token that mints the
 * next pair. A bundle promoted from the pre-0.10 single-JWT file has a null
 * refresh — it cannot be rotated and the user must log in again when it
 * expires. See docs/token-refresh.md.
 */
export interface TokenBundle {
  v: number;
  access: string;
  /** Unix seconds. Absent for legacy tokens and for opaque access tokens. */
  access_expires_at?: number;
  refresh: string | null;
  /** Unix seconds. Absent when the server does not report it. */
  refresh_expires_at?: number;
}

const TOKEN_FORMAT_VERSION = 1;

function coerceUnixSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Promotes a legacy single-JWT file to the bundle shape so that every caller
 * handles exactly one type. The expiry is read from the JWT itself, which is
 * what `doctor` has always done.
 */
function promoteLegacyToken(raw: string): TokenBundle {
  return {
    v: TOKEN_FORMAT_VERSION,
    access: raw,
    access_expires_at: coerceUnixSeconds(decodeJwtClaims(raw)?.exp),
    refresh: null,
  };
}

/**
 * Parses either storage format.
 *
 * The discriminator is a leading `{`, per the spec — deliberately not
 * "JSON.parse succeeds", because a JWT is not valid JSON but a truncated write
 * could be neither, and treating unparseable JSON as a legacy token would hand
 * the server half a file as a bearer credential.
 */
export function parseTokenFile(contents: string): TokenBundle | null {
  const trimmed = contents.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("{")) return promoteLegacyToken(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A corrupt bundle is not a credential. Returning null reads as logged
    // out, which prompts a re-login instead of sending garbage as a token.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access !== "string" || !obj.access) return null;

  return {
    v: typeof obj.v === "number" ? obj.v : TOKEN_FORMAT_VERSION,
    access: obj.access,
    access_expires_at: coerceUnixSeconds(obj.access_expires_at),
    refresh: typeof obj.refresh === "string" && obj.refresh ? obj.refresh : null,
    refresh_expires_at: coerceUnixSeconds(obj.refresh_expires_at),
  };
}

export function serializeTokenBundle(bundle: TokenBundle): string {
  return JSON.stringify(
    {
      v: bundle.v ?? TOKEN_FORMAT_VERSION,
      access: bundle.access,
      ...(bundle.access_expires_at !== undefined
        ? { access_expires_at: bundle.access_expires_at }
        : {}),
      ...(bundle.refresh ? { refresh: bundle.refresh } : {}),
      ...(bundle.refresh_expires_at !== undefined
        ? { refresh_expires_at: bundle.refresh_expires_at }
        : {}),
    },
    null,
    2
  );
}

/**
 * Writes the bundle atomically (temp file + rename), mode 0600.
 *
 * Hooks read this file while other hooks refresh it. A plain writeFileSync
 * truncates first, so a concurrent reader would see an empty or half-written
 * file and read as logged out — which, on the hook path, silently drops the
 * upload.
 */
export function saveTokenBundle(bundle: TokenBundle): void {
  ensureConfigDir();
  writeSecretAtomic(getTokenPath(), serializeTokenBundle(bundle) + "\n");
}

/**
 * Sibling temp file + rename, mode 0600. The caller names the target: `.token`
 * and each `.cred` belong to different servers and never share a default.
 */
function writeSecretAtomic(target: string, contents: string): void {
  const tmpPath = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, contents, { encoding: "utf-8", mode: 0o600 });
    // renameSync preserves the temp file's mode, so 0600 carries over. An
    // existing target's mode does not survive, which is why the temp file is
    // created with the mode we want rather than chmod'ed afterwards.
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/** Reads the stored bundle, promoting a legacy single-JWT file. */
export function loadTokenBundle(): TokenBundle | null {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return parseTokenFile(fs.readFileSync(tokenPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Saves the auth token to a file with restricted permissions (0600).
 *
 * Accepts a bare access token (what `login` used to paste) or a full bundle.
 */
export function saveToken(token: string | TokenBundle): void {
  const bundle: TokenBundle =
    typeof token === "string" ? promoteLegacyToken(token) : token;
  saveTokenBundle(bundle);
}

/**
 * Loads the auth token. Returns null if not found.
 *
 * Returns the ACCESS token, so the existing callers (status, doctor,
 * install-hooks) keep working unchanged against both storage formats. Callers
 * that need to rotate use loadTokenBundle().
 */
export function loadToken(): string | null {
  return loadTokenBundle()?.access ?? null;
}

/**
 * Deletes the stored auth token securely (overwrites before removing).
 */
export function deleteToken(): void {
  // A lock left behind by a killed hook would otherwise outlive the credential
  // it guarded, and delay the first refresh after the next login by the full
  // stale timeout.
  releaseTokenLock();

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return;
  try {
    const len = fs.statSync(tokenPath).size;
    if (len > 0) {
      fs.writeFileSync(tokenPath, Buffer.alloc(len, 0));
    }
    fs.unlinkSync(tokenPath);
  } catch {
    // best-effort
  }
}

export function hasToken(): boolean {
  return loadToken() !== null;
}
