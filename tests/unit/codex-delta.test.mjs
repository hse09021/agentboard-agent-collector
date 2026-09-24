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

// cacheCreation5m/1h are a TTL breakdown of cacheCreationTokens (priced 1.25x
// and 2x input), carried through the ledger but never part of totalTokens.
const totals = (i, o, c, cc = 0, cc5 = 0, cc1h = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheCreationTokens: cc,
  cacheCreation5mTokens: cc5,
  cacheCreation1hTokens: cc1h,
  cacheReadTokens: c,
  totalTokens: i + o + c + cc,
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
    expect(config.getSentTotals('claude_code', 'sess-1')).toEqual(totals(0, 0, 0));
  });
});

describe('hook-sent.json pruning', () => {
  it('drops entries older than the retention window on the next write', () => {
    const old = new Date('2020-01-01T00:00:00Z').toISOString();
    const recent = new Date().toISOString();
    writeFileSync(
      config.HOOK_SENT_PATH,
      JSON.stringify({
        'codex:old-session': { sentAt: old, totals: totals(100, 50, 10) },
        'codex:recent-session': { sentAt: recent, totals: totals(5, 5, 0) },
      })
    );

    // Any write triggers pruning.
    config.markTotalsSent('codex', 'new-session', totals(1, 1, 0));

    const sent = config.loadHookSent();
    expect(sent['codex:old-session']).toBeUndefined(); // pruned
    expect(sent['codex:recent-session']).toBeDefined(); // within window
    expect(sent['codex:new-session']).toBeDefined(); // just written
  });

  it('keeps entries with no parseable sentAt (cannot age them)', () => {
    writeFileSync(
      config.HOOK_SENT_PATH,
      JSON.stringify({ 'codex:no-ts': { totals: totals(3, 3, 0) } })
    );

    config.markTotalsSent('codex', 'x', totals(1, 1, 0));

    expect(config.loadHookSent()['codex:no-ts']).toBeDefined();
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
      // Summed field-agnostically so adding a token field to the ledger cannot
      // silently drop it from this conservation check.
      summed = Object.fromEntries(
        Object.keys(summed).map((field) => [field, summed[field] + delta[field]])
      );
      // Only persist (mark as uploaded) when a non-zero delta would be sent —
      // mirrors codex/notify.mjs which skips upload + persist on a zero delta.
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

// A Claude Code session can be resumed days after its first SessionEnd, so the
// same delta accounting has to hold there. Session-level dedup used to upload
// the first stretch only and silently drop everything the resume added.
describe('resumed Claude Code session', () => {
  it('uploads only the tokens added after the session was resumed', () => {
    const sessionId = '54dd0081-6347-48fc-95c4-0fbcbb885cce';
    const afterFirstEnd = totals(50, 20, 1800, 300);
    const afterResume = totals(75, 258, 109037, 4102);

    const first = config.computeDelta(
      afterFirstEnd,
      config.getSentTotals('claude_code', sessionId)
    );
    config.markTotalsSent('claude_code', sessionId, afterFirstEnd);

    const second = config.computeDelta(
      afterResume,
      config.getSentTotals('claude_code', sessionId)
    );

    expect(second.totalTokens).toBe(
      afterResume.totalTokens - afterFirstEnd.totalTokens
    );
    expect(first.totalTokens + second.totalTokens).toBe(afterResume.totalTokens);
  });

  it('carries cache creation tokens through the delta', () => {
    const sessionId = 'cache-create';
    config.markTotalsSent('claude_code', sessionId, totals(0, 0, 0, 300));
    const delta = config.computeDelta(
      totals(0, 0, 0, 4102),
      config.getSentTotals('claude_code', sessionId)
    );
    expect(delta.cacheCreationTokens).toBe(3802);
  });
});

describe('Claude Code records written before per-response counting', () => {
  const sessionId = 'line-counted';

  function writeRecord(record) {
    writeFileSync(config.HOOK_SENT_PATH, JSON.stringify({ [`claude_code:${sessionId}`]: record }));
  }

  it('converts a record without the marker once, keeping its route and sentAt', () => {
    writeRecord({ sentAt: '2026-09-01T00:00:00.000Z', totals: totals(300, 30, 0), route: 'binding:acme' });
    const convert = vi.fn(() => totals(100, 10, 0));

    const first = config.upgradeLineCountedTotals(sessionId, convert);
    const second = config.upgradeLineCountedTotals(sessionId, convert);

    expect(first).toEqual({ from: 330, to: 110 });
    expect(second).toBeNull();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith(totals(300, 30, 0));
    expect(config.getSentTotals('claude_code', sessionId).totalTokens).toBe(110);
    expect(config.getSentRoute('claude_code', sessionId)).toBe('binding:acme');
    expect(config.loadHookSent()[`claude_code:${sessionId}`].sentAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps a seeded record seeded', () => {
    writeRecord({ sentAt: '2026-09-01T00:00:00.000Z', totals: totals(300, 30, 0), seeded: true });

    config.upgradeLineCountedTotals(sessionId, () => totals(100, 10, 0));

    expect(config.getSentRoute('claude_code', sessionId)).toBeNull();
  });

  it('never converts what this collector wrote', () => {
    config.markTotalsSent('claude_code', sessionId, totals(100, 10, 0));
    const convert = vi.fn();

    expect(config.upgradeLineCountedTotals(sessionId, convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it('marks records from every Claude Code writer, and no Codex ones', () => {
    config.markTotalsSent('claude_code', 'a', totals(1, 1, 0));
    config.markTotalsSeeded('claude_code', 'b', totals(1, 1, 0));
    config.markTotalsSentMonotonic('claude_code', 'c', totals(1, 1, 0));
    config.markTotalsSent('codex', 'd', totals(1, 1, 0));

    const sent = config.loadHookSent();
    expect(sent['claude_code:a'].counting).toBe('per-response');
    expect(sent['claude_code:b'].counting).toBe('per-response');
    expect(sent['claude_code:c'].counting).toBe('per-response');
    expect(sent['codex:d'].counting).toBeUndefined();
  });

  it('leaves the record for next time when it cannot be converted', () => {
    writeRecord({ sentAt: '2026-09-01T00:00:00.000Z', totals: totals(300, 30, 0) });

    expect(config.upgradeLineCountedTotals(sessionId, () => null)).toBeNull();
    expect(config.getSentTotals('claude_code', sessionId).totalTokens).toBe(330);
  });
});
