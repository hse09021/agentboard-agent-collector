/**
 * Tests for the Codex per-turn delta accounting helpers in
 * plugin/hooks/lib/config.mjs (computeDelta / getSentTotals / markTotalsSent).
 *
 * Codex fires its notify hook once per turn, so a session's cumulative token
 * total grows across many invocations. These tests prove that we upload only
 * the delta accrued since the previous turn — never double-counting and never
 * dropping later turns the way plain session-level dedup did.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let config;

// config.mjs resolves its config dir from homedir()/APPDATA at module-load time,
// so we point HOME (and APPDATA on win32) at a temp dir and re-import fresh.
beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-test-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

const totals = (i, o, c) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: c,
  totalTokens: i + o + c,
});

describe('computeDelta', () => {
  it('returns the full totals when nothing was sent before', () => {
    const delta = config.computeDelta(totals(10, 5, 2), config.getSentTotals('codex', 'sess-x'));
    expect(delta).toEqual(totals(10, 5, 2));
  });

  it('returns only tokens accrued since the last upload', () => {
    const delta = config.computeDelta(totals(30, 12, 4), totals(10, 5, 2));
    expect(delta).toEqual(totals(20, 7, 2));
  });

  it('never goes negative if cumulative appears to shrink', () => {
    const delta = config.computeDelta(totals(5, 5, 0), totals(10, 8, 1));
    expect(delta).toEqual(totals(0, 0, 0));
  });
});

describe('getSentTotals / markTotalsSent round-trip', () => {
  it('starts at zero for an unknown session', () => {
    expect(config.getSentTotals('codex', 'never-seen')).toEqual(totals(0, 0, 0));
  });

  it('persists and reads back the cumulative totals', () => {
    config.markTotalsSent('codex', 'sess-1', totals(100, 40, 10));
    expect(config.getSentTotals('codex', 'sess-1')).toEqual(totals(100, 40, 10));
  });

  it('is keyed per source + session id', () => {
    config.markTotalsSent('codex', 'sess-1', totals(100, 40, 10));
    expect(config.getSentTotals('codex', 'sess-2')).toEqual(totals(0, 0, 0));
    expect(config.getSentTotals('gemini', 'sess-1')).toEqual(totals(0, 0, 0));
  });
});

describe('multi-turn Codex session never double-counts', () => {
  it('sum of per-turn deltas equals the final cumulative total', () => {
    const sessionId = 'thread-abc';
    // Cumulative totals the parser would report after each successive turn.
    const cumulativeByTurn = [totals(10, 4, 1), totals(25, 11, 3), totals(25, 11, 3), totals(60, 20, 8)];

    let summed = totals(0, 0, 0);
    for (const cumulative of cumulativeByTurn) {
      const sent = config.getSentTotals('codex', sessionId);
      const delta = config.computeDelta(cumulative, sent);
      summed = {
        inputTokens: summed.inputTokens + delta.inputTokens,
        outputTokens: summed.outputTokens + delta.outputTokens,
        cacheReadTokens: summed.cacheReadTokens + delta.cacheReadTokens,
        totalTokens: summed.totalTokens + delta.totalTokens,
      };
      // Only persist (mark as uploaded) when a non-zero delta would be sent —
      // mirrors codex-notify.mjs which skips upload + persist on a zero delta.
      if (delta.totalTokens > 0) {
        config.markTotalsSent('codex', sessionId, cumulative);
      }
    }

    // Server-side sum of all uploaded deltas must equal the true cumulative.
    expect(summed).toEqual(cumulativeByTurn[cumulativeByTurn.length - 1]);
  });

  it('a repeated turn (no new tokens) yields a zero delta', () => {
    const sessionId = 'thread-rep';
    config.markTotalsSent('codex', sessionId, totals(50, 20, 5));
    const delta = config.computeDelta(totals(50, 20, 5), config.getSentTotals('codex', sessionId));
    expect(delta.totalTokens).toBe(0);
  });
});
