/**
 * Tests for plugin/hooks/lib/parse-usage-limit.mjs
 */

import { describe, it, expect } from 'vitest';
import { parseUsageLimitText } from '../../plugin/hooks/lib/parse-usage-limit.mjs';

describe('parseUsageLimitText — Claude Code /usage output', () => {
  it('extracts 5h and weekly remaining percentages', () => {
    const raw = [
      'Your usage — Pro plan',
      '5-hour limit: 42% remaining',
      'Weekly limit: 81% remaining',
    ].join('\n');

    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(42);
    expect(result.weeklyRemainingPct).toBe(81);
    expect(result.planName).toBe('pro');
    expect(result.raw).toBe(raw);
  });

  it('extracts reset times when present', () => {
    const raw = [
      '5-hour limit: 10% remaining, reset: 2026-07-01T18:00:00Z',
      'Weekly limit: 55% remaining, reset: 2026-07-06T00:00:00Z',
    ].join('\n');

    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.fiveHourResetAt).toBe('2026-07-01T18:00:00.000Z');
    expect(result.weeklyResetAt).toBe('2026-07-06T00:00:00.000Z');
  });
});

describe('parseUsageLimitText — real codex-cli 0.142.4 /status output', () => {
  // Anonymized real sample captured via `codex --no-alt-screen` on 2026-07-01
  // (see /codex.md). Progress-bar block characters and box-drawing borders
  // pad the label-to-value gap well past what a naive regex would allow for.
  const raw = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│  >_ OpenAI Codex (v0.142.4)                                                  │',
    '│                                                                              │',
    '│  Model:                       gpt-5.5 (reasoning xhigh, summaries auto)      │',
    '│  Account:                     [redacted] (Plus)                              │',
    '│  Session:                     019f1c29-1acd-7a33-a7b7-e389f93d9454           │',
    '│                                                                              │',
    '│  5h limit:                    [███████████████████░] 97% left (resets 19:02) │',
    '│  Weekly limit:                [████████████████████] 100% left               │',
    '│                               (resets 14:02 on 8 Jul)                        │',
    '│  GPT-5.3-Codex-Spark limit:                                                  │',
    '│  5h limit:                    [████████████████████] 100% left               │',
    '│                               (resets 19:31)                                 │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n');

  it('extracts the primary account 5h/weekly percentages despite progress-bar padding', () => {
    const result = parseUsageLimitText(raw, { source: 'codex' });
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(97);
    expect(result.weeklyRemainingPct).toBe(100);
  });

  it('extracts the plan name from the "Account: ... (Plan)" line', () => {
    const result = parseUsageLimitText(raw, { source: 'codex' });
    expect(result.planName).toBe('plus');
  });

  it('does not confuse the primary limit with the per-model sub-bucket limit', () => {
    const result = parseUsageLimitText(raw, { source: 'codex' });
    // The Spark sub-bucket further down also says "5h limit: 100%" —
    // the primary account limit (97%) must win since it appears first.
    expect(result.fiveHourRemainingPct).toBe(97);
  });
});

describe('parseUsageLimitText — Codex /status output', () => {
  it('extracts percentages using "five hour" / "weekly" phrasing', () => {
    const raw = ['plan: Plus', 'Five hour limit used, 30% remaining', 'Weekly limit, 64% remaining'].join('\n');

    const result = parseUsageLimitText(raw, { source: 'codex' });
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(30);
    expect(result.weeklyRemainingPct).toBe(64);
    expect(result.planName).toBe('plus');
  });
});

describe('parseUsageLimitText — defensive behavior', () => {
  it('returns parseOk:false with raw preserved on empty input', () => {
    const result = parseUsageLimitText('', { source: 'claude_code' });
    expect(result.parseOk).toBe(false);
    expect(result.raw).toBe('');
    expect(result.fiveHourRemainingPct).toBeUndefined();
  });

  it('returns parseOk:false with raw preserved on unrecognized text', () => {
    const raw = 'Some completely unrelated CLI output with no usage info.';
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.parseOk).toBe(false);
    expect(result.raw).toBe(raw);
  });

  it('never throws on garbled/non-string input', () => {
    expect(() => parseUsageLimitText(undefined)).not.toThrow();
    expect(() => parseUsageLimitText(null)).not.toThrow();
    expect(parseUsageLimitText(null).parseOk).toBe(false);
  });

  it('clamps out-of-range percentages to [0, 100]', () => {
    const raw = '5-hour limit: 150% remaining';
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.fiveHourRemainingPct).toBe(100);
  });

  it('normalizes plan name aliases (e.g. "Max 5x" -> "max5x")', () => {
    const raw = 'plan: Max 5x\n5-hour limit: 20% remaining';
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.planName).toBe('max5x');
  });

  it('does not fail when only one of the two percentages is present', () => {
    const raw = '5-hour limit: 12% remaining';
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(12);
    expect(result.weeklyRemainingPct).toBeUndefined();
  });
});
