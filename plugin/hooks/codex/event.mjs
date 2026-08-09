/**
 * Codex UsageEvent builders, shared by the codex hook entry points
 * (notify.mjs, session-end.mjs, subagent-stop.mjs).
 *
 * Codex-specific (source is always 'codex', no cache_creation_tokens), so this
 * lives under codex/ rather than lib/ — Claude builds its own shape in
 * claude/worker.mjs.
 */

import { generateEventId, COLLECTOR_VERSION } from '../lib/config.mjs';

// A codex UsageEvent carrying one calendar day's slice of a token delta. Used
// for per-turn notify uploads, the SessionEnd residue sweep, and subagent-stop
// (which passes the parent session id so the subagent's tokens roll into that
// session).
//
// `piece.startedAt` falls inside `piece.date`, which is what makes the server
// file these tokens under the day they were actually spent rather than under
// the thread's creation date — a thread started yesterday and resumed today
// used to report all of today's tokens with yesterday's `started_at`.
export function buildUsageEvent(deviceId, sessionId, model, piece) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    model,
    session_id: sessionId,
    started_at: piece.startedAt,
    ended_at: piece.endedAt ?? piece.startedAt,
    input_tokens: piece.inputTokens,
    output_tokens: piece.outputTokens,
    cache_read_tokens: piece.cacheReadTokens,
    total_tokens: piece.totalTokens,
    collector_version: COLLECTOR_VERSION,
  };
}

// A usage-limit-only event: no new token delta, but a rate-limit snapshot is
// still worth uploading. `total_tokens: 0` is valid per the (relaxed) server
// schema.
export function buildUsageOnlyEvent(deviceId, sessionId) {
  const now = new Date().toISOString();
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    session_id: sessionId,
    started_at: now,
    ended_at: now,
    total_tokens: 0,
    collector_version: COLLECTOR_VERSION,
  };
}
