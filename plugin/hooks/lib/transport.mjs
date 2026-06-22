/**
 * agentboard hook transport
 *
 * Sends UsageEvent[] to the agentboard API.
 * POST /v1/events/usage/batch
 */

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
 * @param {string} apiBaseUrl
 * @param {string} authToken
 * @param {string} deviceId
 * @param {object[]} events - UsageEvent array
 */
export async function uploadEvents(apiBaseUrl, authToken, deviceId, events) {
  if (!events || events.length === 0) return;

  const url = `${apiBaseUrl}/v1/events/usage/batch`;
  const body = JSON.stringify({ device_id: deviceId, events });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'User-Agent': `agentboard-hook/0.3.0`,
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

      return;
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
