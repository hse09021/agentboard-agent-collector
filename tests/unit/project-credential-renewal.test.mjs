/**
 * Renewing a connected project's credential from the hooks (0.10.0).
 *
 * Before this, every connection went dark 90 days after `connect`. The
 * behaviours worth pinning are the ones that fail silently:
 *
 *   - renewal must happen inside the window and not on every upload
 *   - a renewal problem must never cost the upload its still-valid credential
 *   - a renewal racing another hook or a `disconnect` must not clobber the
 *     newer state or resurrect a removed connection
 *   - a refusal must be recorded, since nobody reads a hook's output
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'https://agentboard.acme.internal/api/proxy';
const DEVICE = 'dev_1d69bfebaa1b440f92ac4bc4c35d4912';
const REF = '98eec09f0eec6fbe';
const DAY = 24 * 60 * 60;
const NOW = Date.UTC(2026, 8, 13, 3, 0, 0);
const nowSec = Math.floor(NOW / 1000);

let configDir;

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.signature`;
}

/** A 90-day credential with `daysLeft` remaining. */
function credential(daysLeft, extra = {}) {
  const exp = nowSec + daysLeft * DAY;
  return jwt({ sub: 'u1', prj: 'ws_5fe1b29ad406784dc0f4f96d7d34d00e', iat: exp - 90 * DAY, exp, ...extra });
}

function credPath() {
  return join(configDir, 'credentials', `${REF}.cred`);
}

function writeCred(value) {
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(credPath(), value);
}

function renewedResponse(value, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { credential: value, device_id: DEVICE } : value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function load() {
  return import('../../plugin/hooks/lib/project-credential.mjs');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-project-renew-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.stubEnv('AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS', '');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

describe('isProjectRenewalDue', () => {
  it('opens the window 30 days before expiry for a 90-day credential', async () => {
    const { isProjectRenewalDue } = await import('../../plugin/hooks/lib/refresh-policy.mjs');
    const claims = (daysLeft) => ({ iat: nowSec + daysLeft * DAY - 90 * DAY, exp: nowSec + daysLeft * DAY });

    expect(isProjectRenewalDue(claims(31), NOW, {})).toBe(false);
    expect(isProjectRenewalDue(claims(30), NOW, {})).toBe(true);
    expect(isProjectRenewalDue(claims(1), NOW, {})).toBe(true);
  });

  // ★ 서버 TTL을 줄여 갱신을 검증할 때, 상한이 없으면 30일 창이 수명 전체를 덮어
  //   업로드마다 갱신한다.
  it('caps the window at a third of the lifetime', async () => {
    const { isProjectRenewalDue } = await import('../../plugin/hooks/lib/refresh-policy.mjs');
    const shortLived = { iat: nowSec - 30, exp: nowSec + 60 }; // 90s lifetime, 60s left

    expect(isProjectRenewalDue(shortLived, NOW, {})).toBe(false);
    expect(isProjectRenewalDue(shortLived, NOW + 31_000, {})).toBe(true);
  });

  it('does not renew without an expiry', async () => {
    const { isProjectRenewalDue } = await import('../../plugin/hooks/lib/refresh-policy.mjs');
    expect(isProjectRenewalDue({ iat: nowSec }, NOW, {})).toBe(false);
    expect(isProjectRenewalDue(null, NOW, {})).toBe(false);
  });
});

describe('ensureFreshProjectCredential', () => {
  const input = (value) => ({ apiBaseUrl: `${API}/`, credentialRef: REF, credential: value, deviceId: DEVICE });

  it('leaves a credential outside the window alone, without calling the server', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = credential(60);
    writeCred(current);
    const fetchImpl = vi.fn();

    const result = await ensureFreshProjectCredential(input(current), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'current', credential: current });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renews inside the window and stores the new credential', async () => {
    const { ensureFreshProjectCredential } = await load();
    const { COLLECTOR_VERSION } = await import('../../plugin/hooks/lib/config.mjs');
    const current = credential(10);
    const next = jwt({ sub: 'u1', iat: nowSec, exp: Math.floor(Date.now() / 1000) + 90 * DAY });
    writeCred(current);
    const fetchImpl = vi.fn().mockResolvedValue(renewedResponse(next));

    const result = await ensureFreshProjectCredential(input(current), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'renewed', credential: next });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/collector/renew`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${current}`);
    expect(init.headers['User-Agent']).toBe(`agentboard-collector/${COLLECTOR_VERSION}`);
    expect(JSON.parse(init.body)).toEqual({ device_id: DEVICE });
    expect(readFileSync(credPath(), 'utf-8')).toBe(next);
  });

  it('records a refusal once, keeps the current credential, and clears it after a later renewal', async () => {
    const { ensureFreshProjectCredential, PROJECT_RENEWAL_PATH } = await load();
    const current = credential(10);
    writeCred(current);
    // A Response body can be read once, so each call gets its own.
    const refused = vi.fn(async () => renewedResponse({ code: 'not_a_member' }, 403));

    const first = await ensureFreshProjectCredential(input(current), { fetchImpl: refused, nowMs: NOW });
    expect(first).toEqual({ kind: 'refused', credential: current, reason: 'HTTP 403 not_a_member' });
    expect(readFileSync(credPath(), 'utf-8')).toBe(current);

    const recorded = JSON.parse(readFileSync(PROJECT_RENEWAL_PATH, 'utf-8'));
    expect(recorded.failures[REF]).toMatchObject({ status: 403, code: 'not_a_member' });

    // 다음 세션에서 같은 거절이 반복돼도 처음 시각을 지킨다.
    await new Promise((r) => setTimeout(r, 5));
    await ensureFreshProjectCredential(input(current), { fetchImpl: refused, nowMs: NOW });
    expect(JSON.parse(readFileSync(PROJECT_RENEWAL_PATH, 'utf-8')).failures[REF].at).toBe(recorded.failures[REF].at);

    const next = jwt({ sub: 'u1', iat: nowSec, exp: Math.floor(Date.now() / 1000) + 90 * DAY });
    await ensureFreshProjectCredential(input(current), {
      fetchImpl: vi.fn().mockResolvedValue(renewedResponse(next)),
      nowMs: NOW,
    });
    expect(existsSync(PROJECT_RENEWAL_PATH)).toBe(false);
  });

  it('treats server errors, network failures, and unusable replies as transient', async () => {
    const { ensureFreshProjectCredential, PROJECT_RENEWAL_PATH } = await load();
    const current = credential(10);
    writeCred(current);

    const replies = [
      vi.fn().mockResolvedValue(renewedResponse({ error: 'down' }, 503)),
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      vi.fn().mockResolvedValue(renewedResponse('not-a-jwt')),
      vi.fn().mockResolvedValue(renewedResponse(jwt({ sub: 'u1', exp: 1 }))),
    ];
    for (const fetchImpl of replies) {
      const result = await ensureFreshProjectCredential(input(current), { fetchImpl, nowMs: NOW });
      expect(result.kind).toBe('unavailable');
      expect(result.credential).toBe(current);
    }

    expect(readFileSync(credPath(), 'utf-8')).toBe(current);
    expect(existsSync(PROJECT_RENEWAL_PATH)).toBe(false);
  });

  // ★ 서버는 유효한 자격증명만 갱신한다. 만료된 것을 보내 봐야 실패뿐이다.
  it('does not send an expired credential', async () => {
    const { ensureFreshProjectCredential } = await load();
    const expired = credential(-1);
    writeCred(expired);
    const fetchImpl = vi.fn();

    const result = await ensureFreshProjectCredential(input(expired), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'expired', credential: expired });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a credential another hook renewed first', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = credential(10);
    const theirs = jwt({ sub: 'u1', iat: nowSec, exp: nowSec + 90 * DAY, n: 'theirs' });
    const ours = jwt({ sub: 'u1', iat: nowSec, exp: Math.floor(Date.now() / 1000) + 90 * DAY, n: 'ours' });
    writeCred(current);

    const fetchImpl = vi.fn(async () => {
      writeCred(theirs); // the other hook lands while our request is in flight
      return renewedResponse(ours);
    });

    const result = await ensureFreshProjectCredential(input(current), { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ kind: 'superseded', credential: theirs });
    expect(readFileSync(credPath(), 'utf-8')).toBe(theirs);
  });

  // ★ disconnect 가 자격증명을 지운 뒤에 갱신이 도착하면, 연결 없이 살아 있는
  //   자격증명 파일을 되살리게 된다.
  it('does not recreate a credential that was removed mid-flight', async () => {
    const { ensureFreshProjectCredential } = await load();
    const current = credential(10);
    writeCred(current);

    const fetchImpl = vi.fn(async () => {
      unlinkSync(credPath());
      return renewedResponse(jwt({ sub: 'u1', iat: nowSec, exp: Math.floor(Date.now() / 1000) + 90 * DAY }));
    });

    const result = await ensureFreshProjectCredential(input(current), { fetchImpl, nowMs: NOW });

    expect(result.kind).toBe('superseded');
    expect(existsSync(credPath())).toBe(false);
  });
});

describe('resolveUploadContextWithRefresh (Codex hooks and sweep)', () => {
  it('uploads a connected project with the renewed credential', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'agentboard-project-'));
    try {
      const bindings = await import('../../src/core/bindings');
      const { config } = bindings.addBinding(bindings.loadConfigV2(), {
        dir: projectDir,
        server: { api_base_url: API, app_base_url: 'https://agentboard.acme.internal', label: 'Acme', device_id: DEVICE },
        credentialRef: REF,
        projectLabel: 'billing-api',
      });
      bindings.saveConfigV2(config);

      // Real clock here: the upload path does not take an injected time.
      const exp = Math.floor(Date.now() / 1000) + 5 * DAY;
      const current = jwt({ sub: 'u1', iat: exp - 90 * DAY, exp });
      const next = jwt({ sub: 'u1', iat: exp, exp: exp + 90 * DAY });
      writeCred(current);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(renewedResponse(next)));

      const { resolveUploadContextWithRefresh } = await import('../../plugin/hooks/lib/upload-context.mjs');
      const ctx = await resolveUploadContextWithRefresh({ source: 'codex', sessionId: 's1', cwd: projectDir });

      expect(ctx.ok).toBe(true);
      expect(ctx.token).toBe(next);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/collector/renew`);
      expect(readFileSync(credPath(), 'utf-8')).toBe(next);
    } finally {
      vi.unstubAllGlobals();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
