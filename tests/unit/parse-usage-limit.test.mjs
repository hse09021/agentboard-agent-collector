/**
 * Tests for plugin/hooks/lib/parse-usage-limit.mjs
 */

import { describe, it, expect } from 'vitest';
import { parseUsageLimitText, normalizeCodexRateLimits } from '../../plugin/hooks/lib/parse-usage-limit.mjs';

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

describe('parseUsageLimitText — real Claude Code 2.1.197 "/usage" output', () => {
  // Captured via `claude -p "/usage"` in PowerShell (not Git Bash — MSYS
  // path-mangles a leading "/usage" into a file path, which makes the CLI
  // misinterpret it as a real prompt and run a billable turn instead of the
  // local command). Confirmed via the session transcript that the literal
  // string reaches the CLI as a `local_command` with no assistant turn —
  // see the SAFETY note in usage-limit.mjs. Unlike Codex, Claude Code
  // reports "NN% used" (not "remaining"/"left") and labels the 5-hour
  // bucket "Current session" rather than "5-hour".
  const raw = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 55% used · resets Jul 1, 7pm (Asia/Seoul)',
    'Current week (all models): 7% used · resets Jul 3, 12am (Asia/Seoul)',
    '',
    "What's contributing to your limits usage?",
    'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
    '',
    'Last 24h · 103 requests · 3 sessions',
    '  Top skills: /run 55%',
    '',
    'Last 7d · 122 requests · 5 sessions',
    '  Top skills: /run 49%',
  ].join('\n');

  it('extracts the 5h percentage from "Current session: NN% used" and inverts it to remaining', () => {
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(45);
  });

  it('extracts the weekly percentage from "Current week ...: NN% used" and inverts it to remaining', () => {
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.weeklyRemainingPct).toBe(93);
  });

  it('leaves the reset time unset rather than guess at "MMM D, Npm (Zone)" phrasing', () => {
    // Real Claude Code reset times ("Jul 1, 7pm (Asia/Seoul)") have no year,
    // an informal hour, and a non-standard timezone abbreviation — `Date`
    // can't parse this, so parseResetTime() correctly returns undefined
    // rather than a silently wrong timestamp. Not used by recommend.ts
    // (only the percentages and plan name feed the recommendation), so this
    // is a known display-only gap, not a correctness bug.
    const result = parseUsageLimitText(raw, { source: 'claude_code' });
    expect(result.fiveHourResetAt).toBeUndefined();
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

describe('normalizeCodexRateLimits — real codex-cli 0.142.5 app-server output', () => {
  // Captured via `codex app-server` stdio JSON-RPC (`account/rateLimits/read`)
  // on 2026-07-01 — see usage-limit-collector.mjs `readCodexRateLimits()`.
  // Structured JSON, not text — no progress-bar padding to worry about here.
  const rpcResult = {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1782900148 },
      secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1783486948 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null,
      planType: 'prolite',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1782910544 },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1783497344 },
      },
    },
  };
  const raw = JSON.stringify({ id: 2, result: rpcResult });

  it('converts usedPercent to remainingPct by inverting (100 - used)', () => {
    const result = normalizeCodexRateLimits(rpcResult, raw);
    expect(result.parseOk).toBe(true);
    expect(result.fiveHourRemainingPct).toBe(89);
    expect(result.weeklyRemainingPct).toBe(98);
  });

  it('picks the five-hour/weekly buckets by windowDurationMins, not position', () => {
    // primary/secondary are not documented as always 5h/weekly by position —
    // swap them and confirm the shorter window still wins as "five hour".
    const swapped = {
      rateLimits: {
        primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1783486948 },
        secondary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1782900148 },
        planType: 'prolite',
      },
    };
    const result = normalizeCodexRateLimits(swapped, raw);
    expect(result.fiveHourRemainingPct).toBe(89);
    expect(result.weeklyRemainingPct).toBe(98);
  });

  it('converts the unix-epoch resetsAt into an ISO timestamp', () => {
    const result = normalizeCodexRateLimits(rpcResult, raw);
    expect(result.fiveHourResetAt).toBe(new Date(1782900148 * 1000).toISOString());
    expect(result.weeklyResetAt).toBe(new Date(1783486948 * 1000).toISOString());
  });

  it('passes planType through directly (already a clean enum, no regex needed)', () => {
    const result = normalizeCodexRateLimits(rpcResult, raw);
    expect(result.planName).toBe('prolite');
  });

  it('does not confuse the primary account limit with the per-model sub-bucket in rateLimitsByLimitId', () => {
    // rateLimits (the "backward-compatible single-bucket view" per the
    // app-server schema) must win, not rateLimitsByLimitId's other buckets.
    const result = normalizeCodexRateLimits(rpcResult, raw);
    expect(result.fiveHourRemainingPct).toBe(89); // not 100 (the Spark sub-bucket's 0% used)
  });

  it('returns parseOk:false when there is no rateLimits field at all', () => {
    const result = normalizeCodexRateLimits({}, '{}');
    expect(result.parseOk).toBe(false);
    expect(result.raw).toBe('{}');
  });

  it('never throws on garbled/non-object input', () => {
    expect(() => normalizeCodexRateLimits(null, '')).not.toThrow();
    expect(() => normalizeCodexRateLimits(undefined, undefined)).not.toThrow();
    expect(normalizeCodexRateLimits(null, '').parseOk).toBe(false);
  });
});
