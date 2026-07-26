/**
 * Codex UsageEvent builders, shared by the codex hook entry points
 * (notify.mjs, session-end.mjs, subagent-stop.mjs).
 *
 * Codex-specific (source is always 'codex', no cache_creation_tokens), so this
 * lives under codex/ rather than lib/ — Claude builds its own shape in
 * claude/worker.mjs.
 */

import { generateEventId, COLLECTOR_VERSION } from '../lib/config.mjs';

// A codex UsageEvent carrying a token delta. Used for per-turn notify uploads,
// the SessionEnd residue sweep, and subagent-stop (which passes the parent
// session id so the subagent's tokens roll into that session).
export function buildUsageEvent(deviceId, sessionId, parsed, delta) {
  return {
    schema_version: '1.0',
    event_id: generateEventId(),
    device_id: deviceId,
    source: 'codex',
    model: parsed.model,
    session_id: sessionId,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt ?? new Date().toISOString(),
    input_tokens: delta.inputTokens,
    output_tokens: delta.outputTokens,
    cache_read_tokens: delta.cacheReadTokens,
    total_tokens: delta.totalTokens,
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
