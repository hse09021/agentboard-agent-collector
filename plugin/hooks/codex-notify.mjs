#!/usr/bin/env node
/**
 * agentboard Codex CLI notify hook
 *
 * Registered in ~/.codex/config.toml as:
 *   notify = ["/path/to/node", "/path/to/codex-notify.mjs"]
 *
 * Codex CLI calls this script after each turn (not just session end),
 * passing a JSON payload as the last argument:
 *   {"thread-id":"<uuid>","status":"..."}
 *
 * Because Codex fires notify per-turn and the session file may not be
 * fully written yet, this script retries up to RETRY_MAX times with a
 * short delay before giving up.
 */

import { parseCodexSession, parseLatestCodexSession } from './lib/parse-codex.mjs';
import {
  loadConfig,
  loadToken,
  generateEventId,
  isSessionSent,
  markSessionSent,
  COLLECTOR_VERSION,
  getApiBaseUrl,
} from './lib/config.mjs';
import { uploadEvents } from './lib/transport.mjs';

const RETRY_MAX = 6;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSessionId() {
  const raw = process.argv[process.argv.length - 1];
  if (!raw || raw.startsWith('-')) return null;

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return (
        obj['thread-id'] ||
        obj.thread_id ||
        obj.threadId ||
        obj.session_id ||
        null
      );
    }
  } catch {
    // Not JSON — might be a bare session ID passed directly
  }

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--thread' || args[i] === '--session') && args[i + 1]) {
      return args[i + 1];
    }
  }

  if (raw && !raw.startsWith('-') && raw.length > 8) return raw;
  return null;
}

function buildUsageEvent(deviceId, sessionId, parsed) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    model: parsed.model,
    session_id: sessionId,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt ?? new Date().toISOString(),
    input_tokens: parsed.inputTokens,
    output_tokens: parsed.outputTokens,
    cache_read_tokens: parsed.cacheReadTokens,
    total_tokens: parsed.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

async function main() {
  let sessionId = parseSessionId();

  if (!sessionId) {
    process.stderr.write('agentboard-codex: no session ID in notify payload\n');
    process.exit(0);
  }

  const config = loadConfig();
  const token = loadToken();

  if (!config || !token) {
    process.exit(0);
  }

  let parsed = null;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    parsed = parseCodexSession(sessionId);
    if (!parsed) {
      parsed = parseLatestCodexSession();
      if (parsed?.sessionId) sessionId = parsed.sessionId;
    }
    if (parsed && parsed.totalTokens > 0) break;
    if (attempt < RETRY_MAX - 1) await sleep(RETRY_DELAY_MS);
  }

  if (!parsed || parsed.totalTokens === 0) {
    process.exit(0);
  }

  if (parsed.sessionId) sessionId = parsed.sessionId;

  if (isSessionSent('codex', sessionId)) {
    process.exit(0);
  }

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);
  const event = buildUsageEvent(deviceId, sessionId, parsed);

  try {
    await uploadEvents(apiBaseUrl, token, deviceId, [event]);
    markSessionSent('codex', sessionId);
  } catch (err) {
    process.stderr.write(`agentboard-codex: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`agentboard-codex: unexpected error: ${err.message}\n`);
  process.exit(0);
});
