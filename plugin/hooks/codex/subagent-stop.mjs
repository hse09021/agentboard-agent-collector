#!/usr/bin/env node
/**
 * agentboard Codex SubagentStop hook
 *
 * Registered in ~/.codex/hooks.json under `SubagentStop`. Codex runs subagents
 * as separate child threads whose token usage lives in their own rollout file
 * and is explicitly NOT merged into the parent event stream / rollout (see
 * codex-rs `codex_delegate.rs`, which drops child `TokenCount` events). The
 * parent `notify` hook therefore never sees subagent tokens, and neither does
 * a parent-only SessionEnd sweep. This hook closes that gap: it reads the
 * child's tokens from `agent_transcript_path` and attributes them to the parent
 * session, so account usage isn't under-counted.
 *
 * Receives one JSON object on stdin:
 *   { session_id (parent), agent_id, agent_type, agent_transcript_path, ... }
 * The transcript path / cwd fields are read only — never uploaded (the event we
 * build carries counts, model, timestamps and the parent session id only).
 */

import { parseCodexFile } from './parse-codex.mjs';
import {
  loadConfig,
  loadToken,
  generateEventId,
  getSentTotals,
  markTotalsSent,
  computeDelta,
  COLLECTOR_VERSION,
  getApiBaseUrl,
} from '../lib/config.mjs';
import { uploadEvents } from '../lib/transport.mjs';
import { assertNoForbiddenFields } from '../lib/forbidden-data-guard.mjs';

const RETRY_MAX = 6;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function buildSubagentEvent(deviceId, parentSessionId, parsed, delta) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    model: parsed.model,
    session_id: parentSessionId,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt ?? new Date().toISOString(),
    input_tokens: delta.inputTokens,
    output_tokens: delta.outputTokens,
    cache_read_tokens: delta.cacheReadTokens,
    total_tokens: delta.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

async function main() {
  if (process.env.AGENTBOARD_INTERNAL === '1') process.exit(0);

  let payloadText = '';
  try {
    payloadText = await readStdin();
  } catch {
    process.exit(0);
  }

  let payload = {};
  try {
    if (payloadText.trim()) payload = JSON.parse(payloadText);
  } catch {
    process.exit(0);
  }

  const parentSessionId = payload.session_id ?? payload.sessionId;
  const agentId = payload.agent_id ?? payload.agentId;
  const transcriptPath =
    payload.agent_transcript_path ?? payload.agentTranscriptPath;
  if (!parentSessionId || !agentId || !transcriptPath) process.exit(0);

  const config = loadConfig();
  const token = loadToken();
  if (!config || !token) process.exit(0);

  // The child rollout may still be flushing when the hook fires — retry like
  // codex-notify does for the parent session file.
  let parsed = null;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    parsed = parseCodexFile(transcriptPath);
    if (parsed && parsed.totalTokens > 0) break;
    if (attempt < RETRY_MAX - 1) await sleep(RETRY_DELAY_MS);
  }
  if (!parsed || parsed.totalTokens <= 0) process.exit(0);

  // Dedup is keyed on the SUBAGENT (a subagent can, in principle, report more
  // than once), but the event is uploaded under the PARENT session id so the
  // tokens roll into that session's total rather than spawning a phantom
  // session. `sub:` prefix keeps the ledger key from ever colliding with a real
  // codex session id.
  const ledgerKey = `sub:${agentId}`;
  const alreadySent = getSentTotals('codex', ledgerKey);
  const delta = computeDelta(parsed, alreadySent);
  if (delta.totalTokens <= 0) process.exit(0);

  const deviceId = config.device_id;
  const apiBaseUrl = getApiBaseUrl(config);
  const event = buildSubagentEvent(deviceId, parentSessionId, parsed, delta);

  try {
    assertNoForbiddenFields(event);
  } catch (err) {
    process.stderr.write(
      `agentboard-codex-subagent: forbidden field detected, upload aborted: ${err.message}\n`
    );
    process.exit(1);
  }

  try {
    await uploadEvents(apiBaseUrl, token, deviceId, [event]);
    markTotalsSent('codex', ledgerKey, parsed);
  } catch (err) {
    process.stderr.write(`agentboard-codex-subagent: upload failed: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
