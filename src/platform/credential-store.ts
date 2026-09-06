import * as fs from "fs";
import * as path from "path";
import { getTokenPath, getConfigDir, ensureConfigDir } from "../core/config";

/**
 * Per-route credentials.
 *
 * The community server keeps using .token (written by `agentboard login`).
 * Every connected project gets its own file under credentials/, because the
 * enrollment credential is scoped to one project on one server — losing or
 * revoking one must not touch the others.
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

export function saveCredential(ref: string, credential: string): void {
  const target = getCredentialPath(ref);
  fs.mkdirSync(getCredentialsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, credential, { encoding: "utf-8", mode: 0o600 });
}

export function loadCredential(ref: string): string | null {
  let target: string;
  try {
    target = getCredentialPath(ref);
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  try {
    return fs.readFileSync(target, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Overwrites the bytes before unlinking, same as deleteToken(). */
export function deleteCredential(ref: string): void {
  let target: string;
  try {
    target = getCredentialPath(ref);
  } catch {
    return;
  }
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
 * Saves the auth token to a file with restricted permissions (0600).
 */
export function saveToken(token: string): void {
  ensureConfigDir();
  fs.writeFileSync(getTokenPath(), token, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Loads the auth token. Returns null if not found.
 */
export function loadToken(): string | null {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return fs.readFileSync(tokenPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Deletes the stored auth token securely (overwrites before removing).
 */
export function deleteToken(): void {
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
