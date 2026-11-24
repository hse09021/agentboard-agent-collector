/**
 * Claude Code JSONL session parser for hook scripts.
 *
 * Privacy: reads only message.usage, message.model and the message/request ids
 * from assistant entries with a stop_reason. finalResponseWritten additionally
 * reads an entry's type, isSidechain and isMeta flags and message.stop_reason.
 * The message.content field is never accessed.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_FIELDS, addToDayBucket, sortDayBuckets } from '../lib/daily-split.mjs';
import { contextSizeBucket, makeBucketKey } from '../lib/usage-buckets.mjs';

function toNN(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toIso(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Read one transcript file: its metadata, plus every assistant line that
 * carries usage, in file order. Lines, not responses — see uniqueResponses.
 */
function readTranscriptFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  let model;
  let startedAt;
  let endedAt;
  // Routing anchor. The hook payload carries `cwd` for the live session, but a
  // session discovered by the cross-agent sweep has no payload — so the working
  // directory has to come from the transcript itself. Read only to pick a
  // destination server; never uploaded.
  let cwd;
  let lastSeenTs;
  const usageLines = [];

  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Present on user/assistant entries (not on the leading operation entry).
    if (!cwd && typeof parsed.cwd === 'string' && parsed.cwd) cwd = parsed.cwd;

    const ts = toIso(parsed.timestamp);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
      lastSeenTs = ts;
    }

    if (parsed.type !== 'assistant') continue;
    const msg = parsed.message;
    if (!msg || typeof msg !== 'object') continue;

    const msgModel = typeof msg.model === 'string' ? msg.model : '';
    if (!msgModel || msgModel === '<synthetic>') continue;
    if (!msg.stop_reason) continue;

    model = msgModel;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') continue;

    // Anthropic bills the two cache-write TTLs at different multiples of the
    // input price (5-minute writes at 1.25x, 1-hour at 2x), and reports the
    // split under `usage.cache_creation`. Collapsing them into one number is
    // why cache-heavy sessions could not be costed correctly. These are a
    // BREAKDOWN of cacheCreationTokens — never added to the total.
    const cacheCreation =
      usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};

    const turn = {
      inputTokens: toNN(usage.input_tokens),
      outputTokens: toNN(usage.output_tokens),
      cacheCreationTokens: toNN(usage.cache_creation_input_tokens),
      cacheCreation5mTokens: toNN(cacheCreation.ephemeral_5m_input_tokens),
      cacheCreation1hTokens: toNN(cacheCreation.ephemeral_1h_input_tokens),
      cacheReadTokens: toNN(usage.cache_read_input_tokens),
    };
    turn.totalTokens =
      turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;

    // What this response is priced as (usage-buckets.mjs): its own model —
    // a subagent or a background call can run on a different one — its speed
    // (fast mode bills at a multiple), the price tier its prompt size falls in
    // (input + cache reads + cache writes, Anthropic's definition), and where
    // it was served.
    const key = makeBucketKey({
      model: msgModel,
      speed: usage.speed,
      contextSizeBucket: contextSizeBucket(
        turn.inputTokens + turn.cacheReadTokens + turn.cacheCreationTokens
      ),
      inferenceGeo: usage.inference_geo,
    });

    usageLines.push({
      // A line with no message id (very old transcripts) cannot be grouped, so
      // it stands alone.
      responseId: msg.id ? `${msg.id}:${parsed.requestId ?? ''}` : `${filePath}:${i}`,
      // An entry without its own timestamp falls back to the last one seen, so
      // it lands on the day it was actually written rather than being dropped.
      ts: ts ?? lastSeenTs ?? startedAt ?? new Date().toISOString(),
      turn,
      key,
    });
  }

  return { model, cwd, startedAt, endedAt, usageLines };
}

/** The parent transcript first, then its <session>/subagents/*.jsonl. */
function readSessionFiles(transcriptPath) {
  const filePaths = [transcriptPath];

  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  if (existsSync(subagentsDir)) {
    try {
      readdirSync(subagentsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .forEach((f) => filePaths.push(join(subagentsDir, f)));
    } catch { /* ignore */ }
  }

  return filePaths.map(readTranscriptFile).filter(Boolean);
}

// ─── Has the turn's last response reached the file? ──────────────────────────

// Enough to reach past the request blobs and attachments Claude Code writes
// around a response. A transcript whose answer lies further back is read whole.
const TAIL_BYTES = 4 * 1024 * 1024;

function readTail(filePath, bytes) {
  const fd = openSync(filePath, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf-8'), whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the lines from the end, stopping at the first one that tells: a
 * response that ended the turn (true), or a response that called a tool or a
 * user line, either of which must still be answered (false). Undefined when
 * no line tells.
 */
function lastLineEndsTurn(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the line being written, or the cut at the start of a tail
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain === true) continue;

    if (entry.type === 'assistant') {
      const message = entry.message && typeof entry.message === 'object' ? entry.message : null;
      const stopReason = message ? message.stop_reason : null;
      // A line written before its response finished carries no stop reason.
      if (!stopReason) continue;
      return stopReason !== 'tool_use';
    }
    // The prompt, or a tool result: a response still has to follow it.
    if (entry.type === 'user' && entry.isMeta !== true) return false;
  }
  return undefined;
}

/**
 * Whether the response that ended the latest turn has been written to the
 * transcript (#25).
 *
 * Claude Code writes the transcript asynchronously, and the Stop hook can fire
 * before the turn's last response is on disk. Parsed then, the upload misses
 * that response, and it is only sent with the next hook. The turn is over when
 * Stop fires, so its last response cannot have stopped to call a tool: if the
 * newest response or user line is a tool call, a tool result or the prompt,
 * the answer is still on its way.
 *
 * Returns true or false, or null when the transcript cannot be read.
 */
export function finalResponseWritten(transcriptPath) {
  try {
    const tail = readTail(transcriptPath, TAIL_BYTES);
    const decided = lastLineEndsTurn(tail.text.split('\n'));
    if (decided !== undefined || tail.whole) return decided ?? false;
    return lastLineEndsTurn(readFileSync(transcriptPath, 'utf-8').split('\n')) ?? false;
  } catch {
    return null;
  }
}

/**
 * One entry per API response.
 *
 * Claude Code writes a response as one line per content block (thinking, text,
 * tool_use), and every one of those lines repeats the response's message id,
 * request id and FULL usage. Summing lines billed a three-block response three
 * times — about 1.8x across real transcripts. The last line of a response wins,
 * as the one written once the response was complete.
 */
function uniqueResponses(usageLines) {
  const responses = new Map();
  for (const line of usageLines) responses.set(line.responseId, line);
  return [...responses.values()];
}

function sumUsageLines(usageLines) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  // Per-day buckets so a session resumed on a later day reports that day's
  // tokens under that day, not under the session's creation date.
  const dayBuckets = new Map();
  for (const { ts, turn } of usageLines) {
    for (const field of TOKEN_FIELDS) totals[field] += turn[field];
    addToDayBucket(dayBuckets, ts, turn);
  }
  return { totals, byDate: sortDayBuckets(dayBuckets) };
}

/**
 * Parse a Claude Code session JSONL file (+ subagent files).
 * Returns aggregated token counts or null if nothing found.
 */
export function parseClaudeSession(transcriptPath) {
  const files = readSessionFiles(transcriptPath);
  if (files.length === 0) return null;

  const responses = uniqueResponses(files.flatMap((file) => file.usageLines));
  const { totals, byDate } = sumUsageLines(responses);
  if (totals.totalTokens === 0) return null;

  let model;
  let cwd;
  let startedAt;
  let endedAt;
  for (const file of files) {
    if (!model && file.model) model = file.model;
    // files[0] is the parent transcript, so first-wins takes the parent's cwd.
    // A subagent can run somewhere else entirely, and the session belongs to
    // where the parent was working.
    if (!cwd && file.cwd) cwd = file.cwd;
    if (file.startedAt && (!startedAt || file.startedAt < startedAt)) startedAt = file.startedAt;
    if (file.endedAt && (!endedAt || file.endedAt > endedAt)) endedAt = file.endedAt;
  }

  return {
    ...totals,
    model,
    cwd,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
    byDate,
    // One entry per API response: what it used, when, and what it is priced
    // as. The upload sums these per bucket key and day, and cuts them at an
    // instant when a directory is connected mid-session. Counts, timestamps
    // and model metadata only.
    entries: responses.map(({ ts, turn, key }) => ({ ts, turn, key })),
  };
}

/**
 * Convert a delta-ledger watermark written while this parser still summed
 * lines into per-response units.
 *
 * Such a watermark overstates what was sent, but it still marks a moment: the
 * upload that wrote it covered every line present at the time. Replaying the
 * transcript in time order under the old rule finds that moment, and counting
 * the responses before it once each gives the same watermark in today's unit.
 * Left unconverted, it would hold back a live session's new usage until the
 * session outgrew the inflated figure.
 *
 * Returns null when the transcript cannot be read.
 */
export function convertLineCountedWatermark(transcriptPath, lineCounted) {
  const files = readSessionFiles(transcriptPath);
  if (files.length === 0) return null;

  const budget = toNN(lineCounted?.totalTokens);
  const inTimeOrder = files
    .flatMap((file) => file.usageLines)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const sent = [];
  let replayed = 0;
  for (const line of inTimeOrder) {
    replayed += line.turn.totalTokens;
    if (replayed > budget) break;
    sent.push(line);
  }
  return sumUsageLines(uniqueResponses(sent)).totals;
}
