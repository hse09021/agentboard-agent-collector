/**
 * Renewing a connected project's device credential (hook runtime).
 *
 * `agentboard connect` stores one credential per connected directory, and the
 * organization server issues it for 90 days. Until 0.10.0 nothing renewed it,
 * so every connection went dark 90 days after `connect`, with a 401 nobody saw.
 *
 * Hooks renew because they are the only code that uploads with these
 * credentials: a machine that is actually used never expires, and one left
 * unused for the whole lifetime does — there is no indefinite bearer.
 *
 * "Project credentials" in docs/token-refresh.md is the contract. The CLI side
 * (src/core/project-credential-status.ts) only reads what this writes.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, COLLECTOR_VERSION, decodeJwtClaims } from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { isProjectRenewalDue } from './refresh-policy.mjs';

const RENEW_TIMEOUT_MS = 15_000;
const CREDENTIAL_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PROJECT_RENEWAL_PATH = join(CONFIG_DIR, 'project-renewal.json');

function credentialPath(ref) {
  return CREDENTIAL_REF_PATTERN.test(ref ?? '') ? join(CONFIG_DIR, 'credentials', `${ref}.cred`) : null;
}

function readCredentialFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8').trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Replaces the credential only if the file still holds the one that was
 * renewed. Returns whether it wrote.
 *
 * - Another hook renewed first: keep theirs. Both are valid, and the server
 *   does not burn anything on a second renewal, so no lock is needed.
 * - The file is gone: the connection was removed or replaced mid-flight.
 *   Recreating it would leave a live credential with no connection.
 */
function replaceCredentialIfUnchanged(path, expected, next) {
  if (readCredentialFile(path) !== expected) return false;

  // Same directory as the target — rename() is only atomic within one
  // filesystem. Hooks read this file concurrently; a truncated read would look
  // like a missing credential and skip the upload.
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, next, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, path);
    return true;
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    return false;
  }
}

// ─── Failure record ───────────────────────────────────────────────────────────

export function readProjectRenewalFailures() {
  try {
    if (!existsSync(PROJECT_RENEWAL_PATH)) return {};
    const parsed = JSON.parse(readFileSync(PROJECT_RENEWAL_PATH, 'utf-8'));
    const failures = parsed?.failures;
    return typeof failures === 'object' && failures !== null ? failures : {};
  } catch {
    return {};
  }
}

function writeFailures(failures) {
  if (Object.keys(failures).length === 0) {
    // Absence is the "nothing wrong" state, as for auth-failure.json.
    if (existsSync(PROJECT_RENEWAL_PATH)) unlinkSync(PROJECT_RENEWAL_PATH);
    return;
  }
  writeJsonAtomic(PROJECT_RENEWAL_PATH, { v: 1, failures });
}

/**
 * Rewritten only when this ref's situation changed. Hooks run on every session
 * end; rewriting an identical record churns a file other hooks are reading and
 * moves `at` forward, hiding how long the refusal has been true.
 */
function recordRefusal(ref, status, code) {
  try {
    const failures = readProjectRenewalFailures();
    const existing = failures[ref];
    if (existing && existing.status === status && (existing.code ?? null) === (code ?? null)) return;
    failures[ref] = { at: new Date().toISOString(), status, ...(code ? { code } : {}) };
    writeFailures(failures);
  } catch {
    // best-effort: never let bookkeeping break an upload
  }
}

function clearRefusal(ref) {
  try {
    const failures = readProjectRenewalFailures();
    if (!(ref in failures)) return;
    delete failures[ref];
    writeFailures(failures);
  } catch {
    /* best-effort */
  }
}

// ─── Renewal ──────────────────────────────────────────────────────────────────

async function postRenew(apiBaseUrl, credential, deviceId, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${String(apiBaseUrl).replace(/\/+$/, '')}/v1/collector/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
        'User-Agent': `agentboard-collector/${COLLECTOR_VERSION}`,
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unavailable', reason: err?.message ?? String(err) };
  }

  if ([400, 401, 403, 404].includes(response.status)) {
    const body = await response.json().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code : undefined;
    return { kind: 'refused', status: response.status, code };
  }
  if (!response.ok) return { kind: 'unavailable', reason: `HTTP ${response.status}` };

  const body = await response.json().catch(() => null);
  const next = typeof body?.credential === 'string' ? body.credential.trim() : '';
  const exp = decodeJwtClaims(next)?.exp;
  // A 2xx without a usable credential is not something to persist: storing it
  // would cut the connection off at the next upload.
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) {
    return { kind: 'unavailable', reason: 'renewal response had no usable credential' };
  }
  return { kind: 'renewed', credential: next };
}

/**
 * Returns the credential to upload with, renewing it first when it is inside
 * its renewal window. Never throws, and never blocks an upload: on any problem
 * the current credential is returned, since it still works until it expires.
 *
 * @param {{apiBaseUrl: string, credentialRef: string, credential: string, deviceId: string}} input
 * @param {{fetchImpl?: typeof fetch, nowMs?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{kind: 'current'|'renewed'|'superseded'|'expired'|'refused'|'unavailable',
 *                    credential: string, reason?: string}>}
 */
export async function ensureFreshProjectCredential(input, options = {}) {
  const { apiBaseUrl, credentialRef, credential, deviceId } = input;
  const nowMs = options.nowMs ?? Date.now();

  try {
    const claims = decodeJwtClaims(credential);
    if (typeof claims?.exp === 'number' && claims.exp * 1000 <= nowMs) {
      // The server renews only a credential that is still valid. Sending this
      // could only fail; `status` tells the user to connect again.
      return { kind: 'expired', credential };
    }
    if (!isProjectRenewalDue(claims, nowMs, options.env)) return { kind: 'current', credential };

    const path = credentialPath(credentialRef);
    if (!path || !deviceId) return { kind: 'current', credential };

    const outcome = await postRenew(apiBaseUrl, credential, deviceId, options.fetchImpl ?? fetch);

    if (outcome.kind === 'refused') {
      recordRefusal(credentialRef, outcome.status, outcome.code);
      return {
        kind: 'refused',
        credential,
        reason: `HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}`,
      };
    }
    if (outcome.kind === 'unavailable') return { kind: 'unavailable', credential, reason: outcome.reason };

    if (!replaceCredentialIfUnchanged(path, credential, outcome.credential)) {
      // Someone else renewed or the connection changed; whatever is on disk now
      // is what the next upload should use.
      return { kind: 'superseded', credential: readCredentialFile(path) ?? credential };
    }
    clearRefusal(credentialRef);
    return { kind: 'renewed', credential: outcome.credential };
  } catch (err) {
    return { kind: 'unavailable', credential, reason: err?.message ?? String(err) };
  }
}
