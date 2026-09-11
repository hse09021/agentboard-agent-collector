/**
 * Deterministic event ids (plugin/hooks/lib/config.mjs deriveEventId).
 *
 * The server dedups on (user_id, event_id). Every upload used to carry a fresh
 * random id, so it could not — which is why correctness rested entirely on the
 * per-session lock, as that lock's own comment admits. Deriving the id from
 * what actually identifies an upload turns the server's uniqueness constraint
 * into the safety net.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let homeDir;
let config;

const piece = (overrides = {}) => ({
  date: '2026-09-10',
  startedAt: '2026-09-10T10:00:00.000Z',
  endedAt: '2026-09-10T11:00:00.000Z',
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 10,
  totalTokens: 160,
  ...overrides,
});

const sent = (totalTokens = 0) => ({
  inputTokens: totalTokens,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens,
});

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-eventid-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('shape', () => {
  it('looks like an event id and fits the server field limit', () => {
    const id = config.deriveEventId('codex', 'sess-1', piece(), sent());
    expect(id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});

describe('same upload, same id', () => {
  it('is stable across calls', () => {
    const a = config.deriveEventId('codex', 'sess-1', piece(), sent(500));
    const b = config.deriveEventId('codex', 'sess-1', piece(), sent(500));
    expect(a).toBe(b);
  });

  it('two hooks racing on one session produce one id', () => {
    // Both read the same ledger and parsed the same file, so both compute the
    // same delta — the server now collapses them instead of double-counting.
    const watermark = sent(500);
    const delta = piece();
    expect(config.deriveEventId('claude_code', 's', delta, watermark)).toBe(
      config.deriveEventId('claude_code', 's', delta, watermark)
    );
  });

  it('tolerates a watermark that omits newer token fields', () => {
    // Ledger records written before the cache-TTL fields existed lack them.
    const withFields = { ...sent(500), cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
    expect(config.deriveEventId('codex', 's', piece(), sent(500))).toBe(
      config.deriveEventId('codex', 's', piece(), withFields)
    );
  });
});

describe('different upload, different id', () => {
  it('changes with the session', () => {
    expect(config.deriveEventId('codex', 'a', piece(), sent())).not.toBe(
      config.deriveEventId('codex', 'b', piece(), sent())
    );
  });

  it('changes with the source', () => {
    expect(config.deriveEventId('codex', 's', piece(), sent())).not.toBe(
      config.deriveEventId('claude_code', 's', piece(), sent())
    );
  });

  it('changes per calendar day of a multi-day split', () => {
    expect(config.deriveEventId('codex', 's', piece({ date: '2026-09-10' }), sent())).not.toBe(
      config.deriveEventId('codex', 's', piece({ date: '2026-09-11' }), sent())
    );
  });

  it('changes when the amounts change', () => {
    expect(config.deriveEventId('codex', 's', piece(), sent())).not.toBe(
      config.deriveEventId('codex', 's', piece({ totalTokens: 161 }), sent())
    );
  });

  it('changes when the watermark it was computed against changes', () => {
    // The next turn's delta is a different upload even if the amounts coincide.
    expect(config.deriveEventId('codex', 's', piece(), sent(0))).not.toBe(
      config.deriveEventId('codex', 's', piece(), sent(500))
    );
  });

  it('distinguishes the cache-write TTL split', () => {
    const fiveMin = piece({ cacheCreationTokens: 100, cacheCreation5mTokens: 100 });
    const oneHour = piece({ cacheCreationTokens: 100, cacheCreation1hTokens: 100 });
    expect(config.deriveEventId('claude_code', 's', fiveMin, sent())).not.toBe(
      config.deriveEventId('claude_code', 's', oneHour, sent())
    );
  });
});

describe('what it deliberately does not fix', () => {
  it('gives a lost ledger a different id, because it is a different upload', () => {
    // Losing the ledger recomputes the delta from zero, so it genuinely covers
    // a different span. Making that collapse would require one event per turn,
    // which multiplies stored rows for every user.
    const afterLoss = piece({ totalTokens: 660, inputTokens: 600 });
    expect(config.deriveEventId('codex', 's', piece(), sent(500))).not.toBe(
      config.deriveEventId('codex', 's', afterLoss, sent(0))
    );
  });
});

describe('generateEventId still exists for snapshot-only events', () => {
  it('is random, because a rate-limit reading is a new observation each time', () => {
    expect(config.generateEventId()).not.toBe(config.generateEventId());
  });
});
