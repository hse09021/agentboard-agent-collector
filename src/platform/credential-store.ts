import * as fs from "fs";
import { getTokenPath, ensureConfigDir } from "../core/config";

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
