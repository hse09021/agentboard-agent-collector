/**
 * agentboard hook transport
 *
 * Sends UsageEvent[] to the agentboard API.
 * POST /v1/events/usage/batch
 */

import { COLLECTOR_VERSION } from './config.mjs';
import { classifyUploadResponse } from './upload-result.mjs';

const SEND_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetriableError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const code = err.cause?.code ?? err.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  );
}

/**
 * Upload a batch of UsageEvents to the agentboard API.
 *
 * Returns the server's per-event verdict (see upload-result.mjs). The caller
 * MUST honour `canAdvanceLedger`: advancing the cumulative-totals ledger past
 * events the server refused for a retriable reason loses them permanently,
 * because deltas are computed against that ledger.
 *
 * @param {string} apiBaseUrl
 * @param {string} authToken
 * @param {string} deviceId
 * @param {object[]} events - UsageEvent array
 * @returns {Promise<ReturnType<typeof classifyUploadResponse>>}
 */
export async function uploadEvents(apiBaseUrl, authToken, deviceId, events) {
  if (!events || events.length === 0) return classifyUploadResponse(null, 0);

  const url = `${apiBaseUrl}/v1/events/usage/batch`;
  const body = JSON.stringify({ device_id: deviceId, events });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'User-Agent': `agentboard-hook/${COLLECTOR_VERSION}`,
  };

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (attempt < MAX_ATTEMPTS - 1 && isTransientStatus(response.status)) {
          lastError = new Error(`HTTP ${response.status}: ${text}`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      // A 2xx alone does not mean every event landed — the server reports
      // per-event rejections inside the body of a 200.
      //
      // Named `responseBody`, not `body`: the request payload above is already
      // called `body` in this scope, and a second `let body` here puts the
      // outer one in the temporal dead zone for the whole block — including the
      // fetch() call that reads it. That shipped in 0.7.0 and broke every
      // upload with "Cannot access 'body' before initialization".
      let responseBody = null;
      try {
        responseBody = await response.json();
      } catch {
        // Older servers, or a proxy that rewrote the body. classify() treats
        // an unreadable body as full success, preserving prior behaviour.
      }
      return classifyUploadResponse(responseBody, events.length);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1 && isRetriableError(err)) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('uploadEvents: exhausted retries');
}


/**
 * Re-registers this device with a server.
 *
 * The hook path needs this because `device_not_found` (404) is otherwise fatal
 * and permanent: the CLI only registers during `login`/`connect`, so a
 * self-hosted server that was reinstalled or had its database reset would drop
 * every upload from every developer with no visible cause.
 *
 * Never throws — the caller treats failure as "could not recover this time".
 *
 * @param {string} apiBaseUrl
 * @param {string} authToken
 * @param {string} deviceId
 * @param {{os?: string, name?: string}} [meta]
 * @returns {Promise<boolean>} whether the device is registered now
 */
export async function registerDevice(apiBaseUrl, authToken, deviceId, meta = {}) {
  try {
    const response = await fetch(`${apiBaseUrl}/v1/collector/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'User-Agent': `agentboard-hook/${COLLECTOR_VERSION}`,
      },
      body: JSON.stringify({
        device_id: deviceId,
        collector_version: COLLECTOR_VERSION,
        ...(meta.os ? { os: meta.os } : {}),
        ...(meta.name ? { name: meta.name } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
