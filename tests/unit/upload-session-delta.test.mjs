/**
 * uploadSessionDelta's edges that the end-to-end hand-off test does not reach:
 * the order of the two legs, what each records, and what happens when one of
 * them cannot go.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REF = 'acme000000000002';
const PROJECT = '/work/acme-api';
const CONNECTED_AT = '2026-11-20T12:00:00.000Z';

let configDir;
let lib;
let config;

const okVerdict = () => ({ parsed: true, accepted: 1, duplicates: 0, rejected: 0, reasons: {}, canAdvanceLedger: true });

function turn(input) {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    totalTokens: input,
  };
}

// 100 uploaded before the connection, 200 more before it, 400 after.
const parsed = {
  ...turn(700),
  model: 'm',
  entries: [
    { ts: '2026-11-20T10:00:00.000Z', turn: turn(100) },
    { ts: '2026-11-20T11:00:00.000Z', turn: turn(200) },
    { ts: '2026-11-20T13:00:00.000Z', turn: turn(400) },
  ],
};

const buildEvent = (deviceId, piece, watermark) => ({
  event_id: `${deviceId}:${piece.date}:${watermark.totalTokens}`,
  device_id: deviceId,
  started_at: piece.startedAt,
  total_tokens: piece.totalTokens,
});

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-upload-delta-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.resetModules();
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev_community',
      default_server: { api_base_url: 'https://community.invalid', app_base_url: 'https://community.invalid', device_id: 'dev_community' },
      bindings: [
        {
          abs_dir: PROJECT,
          real_dir: PROJECT,
          credential_ref: REF,
          connected_at: CONNECTED_AT,
          server: { api_base_url: 'https://org.invalid', app_base_url: 'https://org.invalid', device_id: 'dev_org' },
        },
      ],
    })
  );
  writeFileSync(join(configDir, '.token'), JSON.stringify({ v: 2, access: 'c', access_expires_at: 9_999_999_999 }));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'credentials', `${REF}.cred`),
    JSON.stringify({ v: 2, access: 'o', access_expires_at: 9_999_999_999, refresh: 'r' })
  );

  config = await import('../../plugin/hooks/lib/config.mjs');
  lib = await import('../../plugin/hooks/lib/upload-context.mjs');
  // The session's first turn went to the community server before `connect`.
  config.markTotalsSent('claude_code', 's1', turn(100), 'default');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function recorder(verdicts = {}) {
  const calls = [];
  const upload = async (ctx, events) => {
    calls.push({ routeId: ctx.route.routeId, events });
    const verdict = verdicts[ctx.route.routeId];
    if (verdict instanceof Error) throw verdict;
    return verdict ?? okVerdict();
  };
  return { calls, upload };
}

async function runHandoff(extra = {}) {
  const plan = lib.resolveUploadPlan({ source: 'claude_code', sessionId: 's1', cwd: PROJECT });
  expect(plan).toMatchObject({ ok: true, kind: 'handoff', splitAt: CONNECTED_AT });
  return lib.uploadSessionDelta(plan, { source: 'claude_code', ledgerKey: 's1', parsed, buildEvent, ...extra });
}

const ledgerEntry = () => config.loadHookSent()['claude_code:s1'];

describe('uploadSessionDelta hand-off', () => {
  it('uploads the community tail before the organization side', async () => {
    const { calls, upload } = recorder();
    const outcome = await runHandoff({ upload });

    expect(outcome.status).toBe('sent');
    expect(calls.map((c) => [c.routeId, c.events.reduce((n, e) => n + e.total_tokens, 0)])).toEqual([
      ['default', 200],
      [REF, 400],
    ]);
    expect(ledgerEntry()).toMatchObject({ route: REF, totals: { totalTokens: 700 } });
  });

  it('stops at a retriable rejection of the community tail without touching the organization', async () => {
    const { calls, upload } = recorder({ default: { ...okVerdict(), canAdvanceLedger: false } });
    const outcome = await runHandoff({ upload });

    expect(outcome.status).toBe('held');
    expect(calls.map((c) => c.routeId)).toEqual(['default']);
    expect(ledgerEntry()).toMatchObject({ route: 'default', totals: { totalTokens: 100 } });
  });

  // A community credential that is gone (logged out) leaves the pre-connect
  // tail with nowhere to go. It is never sent to the organization instead.
  it('gives up the tail when there is no community credential, and still sends the rest', async () => {
    unlinkSync(join(configDir, '.token'));
    const { calls, upload } = recorder();
    const outcome = await runHandoff({ upload });

    expect(outcome.skipped).toEqual([{ routeId: 'default', reason: 'no credential for route default', tokens: 200 }]);
    expect(calls.map((c) => [c.routeId, c.events.reduce((n, e) => n + e.total_tokens, 0)])).toEqual([[REF, 400]]);
    expect(ledgerEntry()).toMatchObject({ route: REF, totals: { totalTokens: 700 } });
  });

  // The snapshot was measured where the user works now.
  it('attaches the usage snapshot to the organization side only', async () => {
    const { calls, upload } = recorder();
    await runHandoff({ upload, snapshot: { raw: 'ok', planName: 'pro' }, buildSnapshotOnlyEvent: () => ({}) });

    const [communityCall, orgCall] = calls;
    expect(communityCall.events.some((e) => e.usage_snapshot)).toBe(false);
    expect(orgCall.events.at(-1).usage_snapshot).toMatchObject({ planName: 'pro' });
  });

  it('sends a snapshot-only event to the organization when it has no tokens of its own', async () => {
    const { calls, upload } = recorder();
    const plan = lib.resolveUploadPlan({ source: 'claude_code', sessionId: 's1', cwd: PROJECT });
    const beforeConnect = { ...turn(300), entries: parsed.entries.slice(0, 2) };
    await lib.uploadSessionDelta(plan, {
      source: 'claude_code',
      ledgerKey: 's1',
      parsed: beforeConnect,
      buildEvent,
      upload,
      snapshot: { raw: 'ok' },
      buildSnapshotOnlyEvent: (deviceId) => ({ event_id: 'snap', device_id: deviceId, total_tokens: 0 }),
    });

    expect(calls.map((c) => c.routeId)).toEqual(['default', REF]);
    expect(calls[1].events).toEqual([{ event_id: 'snap', device_id: 'dev_org', total_tokens: 0, usage_snapshot: { raw: 'ok' } }]);
    // The organization received no tokens, so the session is not moved there.
    expect(ledgerEntry()).toMatchObject({ route: 'default', totals: { totalTokens: 300 } });
  });

  it('uploads nothing at all when any event would carry a forbidden field', async () => {
    const { calls, upload } = recorder();
    const leaky = (deviceId, piece, watermark) => ({ ...buildEvent(deviceId, piece, watermark), cwd: PROJECT });
    await expect(runHandoff({ upload, buildEvent: leaky })).rejects.toThrow(/Forbidden field/);
    expect(calls).toEqual([]);
    expect(ledgerEntry()).toMatchObject({ route: 'default', totals: { totalTokens: 100 } });
  });
});

// #23: "listed" scope. Each test rewrites config.json, so the plan is read
// fresh from it.
describe('uploadSessionDelta in listed scope', () => {
  function setScope(scope, tracked = []) {
    const path = join(configDir, 'config.json');
    const current = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...current, bindings: [], default_scope: scope, tracked_dirs: tracked }));
  }
  const plan = () => lib.resolveUploadPlan({ source: 'claude_code', sessionId: 's1', cwd: '/elsewhere' });

  it('uploads nothing for an untracked directory and withholds its tokens', async () => {
    setScope('listed');
    const { calls, upload } = recorder();
    const outcome = await lib.uploadSessionDelta(plan(), {
      source: 'claude_code',
      ledgerKey: 's1',
      parsed,
      buildEvent,
      upload,
      snapshot: { raw: 'ok' },
      buildSnapshotOnlyEvent: () => ({}),
    });

    expect(outcome.status).toBe('untracked');
    expect(calls).toEqual([]);
    // The pin from the earlier community upload is kept; the tokens are behind
    // the watermark now.
    expect(ledgerEntry()).toMatchObject({ route: 'default', totals: { totalTokens: 700 } });
    expect(ledgerEntry().seeded).toBeUndefined();
  });

  it('leaves a session that never uploaded unpinned', async () => {
    setScope('listed');
    const { upload } = recorder();
    await lib.uploadSessionDelta(lib.resolveUploadPlan({ source: 'claude_code', sessionId: 'fresh', cwd: '/elsewhere' }), {
      source: 'claude_code',
      ledgerKey: 'fresh',
      parsed,
      buildEvent,
      upload,
    });
    expect(config.loadHookSent()['claude_code:fresh']).toMatchObject({ seeded: true, totals: { totalTokens: 700 } });
    expect(config.getSentRoute('claude_code', 'fresh')).toBeNull();
  });

  it('sends nothing withheld once the scope is back to all', async () => {
    setScope('listed');
    await lib.uploadSessionDelta(plan(), { source: 'claude_code', ledgerKey: 's1', parsed, buildEvent, upload: recorder().upload });

    setScope('all');
    const more = { ...turn(900), model: 'm', entries: [...parsed.entries, { ts: '2026-11-20T14:00:00.000Z', turn: turn(200) }] };
    const { calls, upload } = recorder();
    await lib.uploadSessionDelta(plan(), { source: 'claude_code', ledgerKey: 's1', parsed: more, buildEvent, upload });
    expect(calls.map((c) => c.events.reduce((n, e) => n + e.total_tokens, 0))).toEqual([200]);
  });

  it('sends a tracked directory only what came after it was added', async () => {
    setScope('listed', [{ abs_dir: '/elsewhere', real_dir: '/elsewhere', added_at: '2026-11-20T12:00:00.000Z' }]);
    const { calls, upload } = recorder();
    await lib.uploadSessionDelta(plan(), { source: 'claude_code', ledgerKey: 's1', parsed, buildEvent, upload });
    expect(calls.map((c) => [c.routeId, c.events.reduce((n, e) => n + e.total_tokens, 0)])).toEqual([['default', 400]]);
    expect(ledgerEntry()).toMatchObject({ route: 'default', totals: { totalTokens: 700 } });
  });
});

