/**
 * Rotating a connected project's access/refresh pair from the hooks (#15).
 *
 * The behaviours worth pinning are the ones that fail silently or burn the
 * connection:
 *
 *   - rotation happens near the access token's expiry, not on every upload
 *   - two hooks rotating the same connection submit the refresh token once
 *     (a second submission is reuse, and the server revokes the family)
 *   - a refresh token the server refused, or one an unsaved rotation spent,
 *     is never sent again
 *   - a transient failure keeps the access token in hand
 *   - a legacy credential moves to a pair without the user doing anything,
 *     and an old server is not asked on every upload
 *   - a 401 on upload rotates once and retries once
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'https://agentboard.acme.internal/api/proxy';
const DEVICE = 'dev_1d69bfebaa1b440f92ac4bc4c35d4912';
const REF = '98eec09f0eec6fbe';
const OTHER_REF = '0b3f6a51c2d94e7a';
const DAY = 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 3, 0, 0);
const nowSec = Math.floor(NOW / 1000);

let configDir;

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.signature`;
}

/** A one-hour access token with `secondsLeft` remaining at `atSec`. */
function access(secondsLeft, { atSec = nowSec, ttl = 3600, n = 'a' } = {}) {
  const exp = atSec + secondsLeft;
  return jwt({ sub: 'u1', prj: 'ws_1', pair: true, iat: exp - ttl, exp, n });
}

function pair(accessToken, refresh, { refreshExpiresAt = nowSec + 90 * DAY } = {}) {
  const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).exp;
  return { v: 2, access: accessToken, access_expires_at: exp, refresh, refresh_expires_at: refreshExpiresAt };
}

/** A 90-day legacy credential with `daysLeft` remaining. */
function legacy(daysLeft, { atSec = nowSec } = {}) {
  const exp = atSec + daysLeft * DAY;
  return jwt({ sub: 'u1', prj: 'ws_1', iat: exp - 90 * DAY, exp });
}

const credPath = (ref = REF) => join(configDir, 'credentials', `${ref}.cred`);

function writeCred(value, ref = REF) {
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(credPath(ref), typeof value === 'string' ? value : JSON.stringify(value));
}

const readCred = (ref = REF) => readFileSync(credPath(ref), 'utf-8');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const input = (ref = REF) => ({ apiBaseUrl: API, credentialRef: ref, deviceId: DEVICE });

async function load() {
  return import('../../plugin/hooks/lib/project-credential.mjs');
}

function renewalRecord() {
  const path = join(configDir, 'project-renewal.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-project-rotate-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.stubEnv('AGENTBOARD_REFRESH_THRESHOLD_SECONDS', '');
  vi.stubEnv('AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS', '');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

describe('rotating a pair', () => {
  it('leaves it alone until the access token is near expiry', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = pair(access(3000), 'r1');
    writeCred(current);
    const fetchImpl = vi.fn();

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'current', credential: current.access });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rotates near expiry through /v1/collector/refresh, without an Authorization header', async () => {
    const { ensureFreshProjectCredential } = await load();
    const { COLLECTOR_VERSION } = await import('../../plugin/hooks/lib/config.mjs');
    writeCred(pair(access(200), 'r1'));
    const next = access(3600, { n: 'next' });
    const fetchImpl = vi.fn(async () => json(pair(next, 'r2')));

    const result = await ensureFreshProjectCredential(
      { ...input(), apiBaseUrl: `${API}/` },
      { fetchImpl, nowMs: NOW },
    );

    expect(result).toEqual({ kind: 'refreshed', credential: next });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/collector/refresh`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['User-Agent']).toBe(`agentboard-collector/${COLLECTOR_VERSION}`);
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'r1', device_id: DEVICE });

    expect(JSON.parse(readCred())).toMatchObject({ v: 2, access: next, refresh: 'r2' });
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(configDir, 'credentials')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // The lock is released.
    expect(existsSync(join(configDir, 'credentials', `${REF}.lock`))).toBe(false);
  });

  // ★ 레거시의 "만료된 자격증명은 보내지 않는다"는 refresh에 해당하지 않는다.
  //   살아 있어야 하는 것은 refresh 쪽이다.
  it('rotates an access token that already expired while the refresh token lives', async () => {
    const { ensureFreshProjectCredential } = await load();
    writeCred(pair(access(-600), 'r1'));
    const next = access(3600, { n: 'next' });
    const fetchImpl = vi.fn(async () => json(pair(next, 'r2')));

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'refreshed', credential: next });
  });

  it('does not send a refresh token past its expiry', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = pair(access(-600), 'r1', { refreshExpiresAt: nowSec - 1 });
    writeCred(current);
    const fetchImpl = vi.fn();

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'expired', credential: current.access });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ★ 이미 소비된 refresh를 또 보내면 서버의 재사용 탐지만 반복된다.
  it.each([
    [401, 'invalid_refresh'],
    [403, 'not_a_member'],
    [403, 'revoked_device'],
    [404, 'project_not_found'],
    [404, 'device_not_found'],
  ])('treats %i %s as final: records it, keeps the access token, never resends', async (status, code) => {
    const { ensureFreshProjectCredential } = await load();
    const current = pair(access(100), 'r1');
    writeCred(current);
    const fetchImpl = vi.fn(async () => json({ code }, status));

    const first = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
    expect(first).toEqual({ kind: 'refused', credential: current.access, reason: `HTTP ${status} ${code}` });
    expect(JSON.parse(readCred())).toEqual(current);

    const failure = renewalRecord().failures[REF];
    expect(failure).toMatchObject({ status, code });
    expect(failure.token_fp).toMatch(/^[0-9a-f]{16}$/);
    // Only a fingerprint is kept, never the token.
    expect(JSON.stringify(renewalRecord())).not.toContain('r1');

    const second = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW, force: true });
    expect(second.kind).toBe('refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['429 rate_limited', () => json({ code: 'rate_limited' }, 429)],
    ['503', () => json({ error: 'down' }, 503)],
    ['400', () => json({ error: 'ZodError' }, 400)],
    ['a network failure', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['a timeout', () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))],
    ['a reply without an access token', () => json({ v: 2, refresh: 'r2' })],
  ])('keeps the access token on %s and asks again next time', async (_label, reply) => {
    const { ensureFreshProjectCredential } = await load();
    const current = pair(access(100), 'r1');
    writeCred(current);
    const fetchImpl = vi.fn(reply);

    for (let i = 0; i < 2; i++) {
      const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
      expect(result.kind).toBe('unavailable');
      expect(result.credential).toBe(current.access);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readCred())).toEqual(current);
    expect(renewalRecord()).toBeNull();
  });

  // ★ 같은 디렉터리에서 Claude Code와 Codex 세션이 함께 끝나면 두 훅이 같은
  //   refresh를 제출한다. 두 번째 제출은 재사용으로 보여 family가 폐기된다.
  it('submits the refresh token once when two hooks rotate the same connection', async () => {
    const { ensureFreshProjectCredential } = await load();
    writeCred(pair(access(100), 'r1'));
    const next = access(3600, { n: 'next' });
    const seen = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      seen.push(JSON.parse(init.body).refresh_token);
      await new Promise((r) => setTimeout(r, 100));
      return json(pair(next, 'r2'));
    });

    const results = await Promise.all([
      ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW }),
      ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW }),
    ]);

    expect(seen).toEqual(['r1']);
    expect(results.map((r) => r.credential)).toEqual([next, next]);
    expect(results.map((r) => r.kind).sort()).toEqual(['refreshed', 'superseded']);
  });

  it('does not make one connection wait for another', async () => {
    const { ensureFreshProjectCredential } = await load();
    const { acquireFileLock, releaseFileLock } = await import('../../plugin/hooks/lib/token-lock.mjs');
    writeCred(pair(access(100), 'r1'));
    writeCred(pair(access(100, { n: 'other' }), 'other-r1'), OTHER_REF);
    const otherLock = join(configDir, 'credentials', `${OTHER_REF}.lock`);
    expect(await acquireFileLock(otherLock)).toBe(true);

    try {
      const next = access(3600, { n: 'next' });
      const started = Date.now();
      const result = await ensureFreshProjectCredential(input(), {
        fetchImpl: vi.fn(async () => json(pair(next, 'r2'))),
        nowMs: NOW,
      });
      expect(result).toEqual({ kind: 'refreshed', credential: next });
      expect(Date.now() - started).toBeLessThan(1000);
      // The default route's lock is never involved either.
      expect(existsSync(join(configDir, '.token.lock'))).toBe(false);
    } finally {
      releaseFileLock(otherLock);
    }
  });

  it('re-reads instead of rotating when the lock is busy', async () => {
    const { ensureFreshProjectCredential } = await load();
    const { acquireFileLock, releaseFileLock } = await import('../../plugin/hooks/lib/token-lock.mjs');
    const current = pair(access(100), 'r1');
    writeCred(current);
    const lock = join(configDir, 'credentials', `${REF}.lock`);
    expect(await acquireFileLock(lock)).toBe(true);
    const fetchImpl = vi.fn();

    try {
      const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
      expect(result.kind).toBe('unavailable');
      expect(result.credential).toBe(current.access);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      releaseFileLock(lock);
    }
  });

  it('does not recreate a connection removed while the request was in flight', async () => {
    const { ensureFreshProjectCredential } = await load();
    writeCred(pair(access(100), 'r1'));
    const fetchImpl = vi.fn(async () => {
      rmSync(credPath());
      return json(pair(access(3600, { n: 'next' }), 'r2'));
    });

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result.kind).toBe('superseded');
    expect(existsSync(credPath())).toBe(false);
  });

  // ★ 서버는 이미 r1을 소비했다. 새 묶음을 저장하지 못하면 r1을 다시 보내지 말고
  //   다시 connect 하라고 안내해야 한다.
  it('records a rotation it could not save, uses the new access once, and never resends the spent token', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = pair(access(100), 'r1');
    writeCred(current);
    // A directory where the temp file goes makes the write fail.
    mkdirSync(`${credPath()}.${process.pid}.tmp`);
    const next = access(3600, { n: 'next' });
    const fetchImpl = vi.fn(async () => json(pair(next, 'r2')));

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result.kind).toBe('save_failed');
    expect(result.credential).toBe(next);
    expect(JSON.parse(readCred())).toEqual(current);
    expect(renewalRecord().failures[REF]).toMatchObject({ code: 'save_failed' });
    expect(renewalRecord().failures[REF].status).toBeUndefined();

    const again = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
    expect(again.kind).toBe('refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // 서버 TTL 60초, 임계값 10초로 실제 회전을 확인한다: 발급 50초 뒤부터만 갱신하고,
  // 그 전에는 서버를 부르지 않는다.
  it('rotates on schedule against a 60-second access TTL with a 10-second threshold', async () => {
    const { ensureFreshProjectCredential } = await load();
    const env = { AGENTBOARD_REFRESH_THRESHOLD_SECONDS: '10' };
    let clockSec = nowSec;
    let serial = 0;
    const issue = () => {
      serial += 1;
      const accessToken = access(60, { atSec: clockSec, ttl: 60, n: `a${serial}` });
      return pair(accessToken, `r${serial}`);
    };
    writeCred(issue());
    const refreshedAt = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const sent = JSON.parse(init.body).refresh_token;
      expect(sent).toBe(`r${serial}`);
      refreshedAt.push(clockSec - nowSec);
      return json(issue());
    });

    for (let t = 0; t < 180; t += 5) {
      clockSec = nowSec + t;
      await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: clockSec * 1000, env });
    }

    expect(refreshedAt).toEqual([50, 100, 150]);
  });
});

describe('exchanging a legacy credential', () => {
  // ★ #6과 같은 함정: 이미 연결된 디렉터리는 사용자가 아무것도 하지 않아도
  //   새 형식으로 넘어와야 한다. 30일 갱신 창을 기다리지 않는다.
  it('asks for a pair on the next upload, outside the renewal window, and stores it', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = legacy(60);
    writeCred(current);
    const next = access(3600, { n: 'next' });
    const fetchImpl = vi.fn(async () => json({ ...pair(next, 'r1'), device_id: DEVICE, server: {}, project: {} }));

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'upgraded', credential: next });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/collector/renew`);
    expect(init.headers.Authorization).toBe(`Bearer ${current}`);
    expect(JSON.parse(init.body)).toEqual({ device_id: DEVICE, v: 2 });
    expect(JSON.parse(readCred())).toMatchObject({ v: 2, access: next, refresh: 'r1' });
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(renewalRecord()).toBeNull();

    // From here on it rotates like any pair, through /refresh, never /renew.
    fetchImpl.mockImplementation(async () => json(pair(access(3600, { atSec: nowSec + 3500, n: 'n2' }), 'r2')));
    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 3500 * 1000 });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${API}/v1/collector/refresh`);
  });

  // ★ 옛 서버는 renew를 부를 때마다 새 90일 자격증명을 준다. 업로드마다 다시
  //   교환을 시도하면 세션마다 자격증명이 하나씩 발급된다.
  it('asks an older server at most once a day, keeping what it renews', async () => {
    const { ensureFreshProjectCredential, readProjectUpgradeAttempts } = await load();
    writeCred(legacy(60));
    // The renewal is validated against the real clock.
    const later = Math.floor(Math.max(NOW, Date.now()) / 1000);
    const renewed = legacy(90, { atSec: later });
    const fetchImpl = vi.fn(async () => json({ credential: renewed, device_id: DEVICE }));

    const first = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
    expect(first).toEqual({ kind: 'renewed', credential: renewed });
    expect(readCred()).toBe(renewed);
    expect(readProjectUpgradeAttempts()[REF]).toMatchObject({ outcome: 'legacy' });

    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 23 * HOUR_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 25 * HOUR_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('picks up a server upgrade at the next daily attempt', async () => {
    const { ensureFreshProjectCredential } = await load();
    const later = Math.floor(Math.max(NOW, Date.now()) / 1000);
    writeCred(legacy(60));
    await ensureFreshProjectCredential(input(), {
      fetchImpl: vi.fn(async () => json({ credential: legacy(90, { atSec: later }) })),
      nowMs: NOW,
    });

    const next = access(3600, { atSec: nowSec + 25 * 3600, n: 'next' });
    const result = await ensureFreshProjectCredential(input(), {
      fetchImpl: vi.fn(async () => json(pair(next, 'r1'))),
      nowMs: NOW + 25 * HOUR_MS,
    });

    expect(result).toEqual({ kind: 'upgraded', credential: next });
    expect(JSON.parse(readCred())).toMatchObject({ refresh: 'r1' });
    // Nothing left to say about this connection.
    expect(renewalRecord()).toBeNull();
  });

  // ★ 서버는 교환하는 즉시 보낸 자격증명을 폐기한다. 받은 묶음을 저장하지 못하면
  //   연결이 끊기므로 기록해서 다시 connect 하라고 안내한다.
  it('records an exchange it could not save and never sends the revoked credential again', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = legacy(60);
    writeCred(current);
    mkdirSync(`${credPath()}.${process.pid}.tmp`);
    const next = access(3600, { n: 'next' });
    const fetchImpl = vi.fn(async () => json(pair(next, 'r1')));

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });

    expect(result.kind).toBe('save_failed');
    expect(result.credential).toBe(next);
    expect(readCred()).toBe(current);
    expect(renewalRecord().failures[REF]).toMatchObject({ code: 'save_failed' });

    const again = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 2 * DAY * 1000 });
    expect(again.kind).toBe('refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not ask after a 401: the server refuses a renew for the same reason', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = legacy(60);
    writeCred(current);
    const fetchImpl = vi.fn();

    const result = await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW, force: true });

    expect(result).toEqual({ kind: 'current', credential: current });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a refused exchange daily, and every upload inside the old renewal window', async () => {
    const { ensureFreshProjectCredential } = await load();
    writeCred(legacy(60));
    const fetchImpl = vi.fn(async () => json({ code: 'not_a_member' }, 403));

    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW });
    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + HOUR_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(renewalRecord().failures[REF]).toMatchObject({ status: 403, code: 'not_a_member' });
    expect(renewalRecord().failures[REF].token_fp).toBeUndefined();

    writeCred(legacy(10));
    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 2 * HOUR_MS });
    await ensureFreshProjectCredential(input(), { fetchImpl, nowMs: NOW + 3 * HOUR_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('uploadWithContext', () => {
  const route = { credentialRef: REF, routeId: REF };
  const unauthorized = () => new Error('HTTP 401: {"code":"invalid_token"}');

  it('rotates once and retries once when a pair gets a 401', async () => {
    const stale = access(3000);
    writeCred(pair(stale, 'r1'));
    const next = access(3600, { atSec: Math.floor(Date.now() / 1000), n: 'next' });
    vi.stubGlobal('fetch', vi.fn(async () => json(pair(next, 'r2'))));
    const uploader = vi
      .fn()
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ canAdvanceLedger: true });
    const { uploadWithContext } = await import('../../plugin/hooks/lib/upload-context.mjs');
    const ctx = { route, apiBaseUrl: API, deviceId: DEVICE, token: stale };

    const verdict = await uploadWithContext(ctx, [{ event_id: 'e1' }], () => {}, uploader);

    expect(verdict).toEqual({ canAdvanceLedger: true });
    expect(uploader.mock.calls.map((c) => c[1])).toEqual([stale, next]);
    expect(ctx.token).toBe(next);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/collector/refresh`);
  });

  it('never loops: a second 401 is the caller\'s', async () => {
    writeCred(pair(access(3000), 'r1'));
    vi.stubGlobal('fetch', vi.fn(async () => json(pair(access(3600, { n: 'next' }), 'r2'))));
    const uploader = vi.fn().mockRejectedValue(unauthorized());
    const { uploadWithContext } = await import('../../plugin/hooks/lib/upload-context.mjs');
    const ctx = { route, apiBaseUrl: API, deviceId: DEVICE, token: access(3000) };

    await expect(uploadWithContext(ctx, [], () => {}, uploader)).rejects.toThrow(/HTTP 401/);
    expect(uploader).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry the default route, a legacy credential, or a non-401 failure', async () => {
    writeCred(legacy(60));
    vi.stubGlobal('fetch', vi.fn());
    const { uploadWithContext } = await import('../../plugin/hooks/lib/upload-context.mjs');

    const defaultRoute = vi.fn().mockRejectedValue(unauthorized());
    await expect(
      uploadWithContext({ route: { credentialRef: null }, apiBaseUrl: API, deviceId: DEVICE, token: 't' }, [], () => {}, defaultRoute),
    ).rejects.toThrow(/HTTP 401/);
    expect(defaultRoute).toHaveBeenCalledTimes(1);

    const legacyRoute = vi.fn().mockRejectedValue(unauthorized());
    await expect(
      uploadWithContext({ route, apiBaseUrl: API, deviceId: DEVICE, token: legacy(60) }, [], () => {}, legacyRoute),
    ).rejects.toThrow(/HTTP 401/);
    expect(legacyRoute).toHaveBeenCalledTimes(1);

    writeCred(pair(access(3000), 'r1'));
    const forbidden = vi.fn().mockRejectedValue(new Error('HTTP 403: {"code":"revoked_device"}'));
    await expect(
      uploadWithContext({ route, apiBaseUrl: API, deviceId: DEVICE, token: 't' }, [], () => {}, forbidden),
    ).rejects.toThrow(/HTTP 403/);
    expect(forbidden).toHaveBeenCalledTimes(1);

    expect(fetch).not.toHaveBeenCalled();
  });
});
