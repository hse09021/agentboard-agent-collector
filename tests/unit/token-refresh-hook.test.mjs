/**
 * Rotation on the HOOK path (stage 3).
 *
 * The hook's copy is the one that actually runs on every session end, and it
 * runs unattended: nobody sees its stderr. So on top of mirroring the CLI's
 * behaviour it must (a) never let a refresh problem block an upload, and
 * (b) never refresh a per-project `.cred`, which is not part of a refresh
 * family at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let configDir;
const API = 'https://api.example.test';

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-hook-refresh-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.stubEnv('AGENTBOARD_REFRESH_THRESHOLD_SECONDS', '300');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

const nowSec = () => Math.floor(Date.now() / 1000);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function writeBundle(bundle) {
  const config = await import('../../plugin/hooks/lib/config.mjs');
  config.saveTokenBundle(bundle);
}

describe('hook ensureFreshToken', () => {
  // ── 레거시 토큰 (이슈 #7) ────────────────────────────────────────────────
  // 훅은 force를 쓰지 않는다. 그래서 레거시 분기가 not-due 조기 리턴 뒤에 있던
  // 동안 이 경로는 통째로 죽어 있었고, 훅은 회전 불가능한 토큰을 멀쩡한 토큰으로
  // 취급하다가 만료와 함께 조용히 업로드를 잃었다.
  it('leaves a healthy legacy token alone', async () => {
    await writeBundle({
      v: 1,
      access: 'legacy',
      access_expires_at: nowSec() + 30 * 24 * 60 * 60,
      refresh: null,
    });
    const fetchSpy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    expect((await ensureFreshToken(API)).kind).toBe('current');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks for a re-login once a legacy token nears expiry, without force', async () => {
    await writeBundle({
      v: 1,
      access: 'legacy',
      access_expires_at: nowSec() + 60 * 60,
      refresh: null,
    });
    const fetchSpy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken, LEGACY_TOKEN_REASON } = await import(
      '../../plugin/hooks/lib/token-refresh.mjs'
    );
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe('reauth_required');
    expect(outcome.reason).toBe(LEGACY_TOKEN_REASON);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays quiet for a legacy token whose expiry cannot be read', async () => {
    await writeBundle({ v: 1, access: 'opaque-no-exp', refresh: null });
    const fetchSpy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    expect((await ensureFreshToken(API)).kind).toBe('current');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call the server when the token has life left', async () => {
    await writeBundle({ v: 1, access: 'acc', access_expires_at: nowSec() + 3600, refresh: 'r1' });
    const fetchSpy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe('current');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rotates and persists when near expiry', async () => {
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    const fetchSpy = vi.fn(() =>
      jsonResponse({
        v: 1,
        access: 'new',
        access_expires_at: nowSec() + 3600,
        refresh: 'r2',
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    const outcome = await ensureFreshToken(API);

    expect(outcome.kind).toBe('refreshed');
    // ★ 요청 키는 refresh_token 이다 (응답 키 refresh 와 다르다). 훅과 CLI 가
    //   같은 서버 스키마를 상대하므로 두 테스트가 같은 것을 고정해야 한다.
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1].body))).toEqual({ refresh_token: 'r1' });
    const config = await import('../../plugin/hooks/lib/config.mjs');
    expect(config.loadTokenBundle()).toMatchObject({ access: 'new', refresh: 'r2' });
  });

  it('keeps the bundle on 5xx', async () => {
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    vi.stubGlobal('fetch', vi.fn(() => new Response('boom', { status: 503 })));

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    expect((await ensureFreshToken(API)).kind).toBe('unavailable');

    const config = await import('../../plugin/hooks/lib/config.mjs');
    expect(config.loadTokenBundle()).toMatchObject({ access: 'old', refresh: 'r1' });
  });

  it('reports reauth_required when the refresh token is rejected', async () => {
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    vi.stubGlobal('fetch', vi.fn(() => new Response('{"code":"invalid"}', { status: 401 })));

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    expect((await ensureFreshToken(API)).kind).toBe('reauth_required');
  });

  // 훅 두 개가 같은 refresh를 동시에 제출하면 서버가 탈취로 보고 로그아웃시킨다.
  it('submits the refresh token only once across concurrent callers', async () => {
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    const fetchSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return jsonResponse({
        v: 1,
        access: 'new',
        access_expires_at: nowSec() + 3600,
        refresh: 'r2',
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { ensureFreshToken } = await import('../../plugin/hooks/lib/token-refresh.mjs');
    await Promise.all([ensureFreshToken(API), ensureFreshToken(API), ensureFreshToken(API)]);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('resolveUploadContextWithRefresh', () => {
  function writeConfig(extra = {}) {
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        version: 2,
        device_id: 'dev_1',
        default_server: {
          api_base_url: API,
          app_base_url: 'https://app.example.test',
          device_id: 'dev_1',
        },
        bindings: [],
        ...extra,
      }),
    );
  }

  it('hands back the rotated access token for the default route', async () => {
    writeConfig();
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse({ v: 1, access: 'new', access_expires_at: nowSec() + 3600, refresh: 'r2' }),
      ),
    );

    const { resolveUploadContextWithRefresh } = await import(
      '../../plugin/hooks/lib/upload-context.mjs'
    );
    const ctx = await resolveUploadContextWithRefresh({ source: 'codex', sessionId: 's1' });

    expect(ctx.ok).toBe(true);
    expect(ctx.token).toBe('new');
  });

  // .cred 는 프로젝트 단위 등록 자격증명이라 회전 대상이 아니다. 여기에 refresh 를
  // 시도하면 엉뚱한 에러가 나고, 최악의 경우 디버깅이 어려운 실패가 된다.
  it('never refreshes a per-project .cred route', async () => {
    writeConfig({
      bindings: [
        {
          credential_ref: 'proj-a',
          abs_dir: '/work/proj-a',
          real_dir: '/work/proj-a',
          server: {
            api_base_url: 'https://other.example.test',
            app_base_url: 'https://other.example.test',
            device_id: 'dev_2',
          },
        },
      ],
    });
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 1, refresh: 'r1' });
    mkdirSync(join(configDir, 'credentials'), { recursive: true });
    writeFileSync(join(configDir, 'credentials', 'proj-a.cred'), 'project-credential');

    const fetchSpy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveUploadContextWithRefresh } = await import(
      '../../plugin/hooks/lib/upload-context.mjs'
    );
    const ctx = await resolveUploadContextWithRefresh({
      source: 'codex',
      sessionId: 's1',
      cwd: '/work/proj-a',
    });

    expect(ctx.ok).toBe(true);
    expect(ctx.token).toBe('project-credential');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 갱신 실패로 업로드를 포기하면 토큰이 아직 살아 있는 경우까지 버리게 된다.
  it('still uploads with the current token when refresh is unavailable', async () => {
    writeConfig();
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    vi.stubGlobal('fetch', vi.fn(() => new Response('boom', { status: 503 })));

    const { resolveUploadContextWithRefresh } = await import(
      '../../plugin/hooks/lib/upload-context.mjs'
    );
    const ctx = await resolveUploadContextWithRefresh({ source: 'codex', sessionId: 's1' });

    expect(ctx.ok).toBe(true);
    expect(ctx.token).toBe('old');
  });

  // 훅은 백그라운드라 사용자가 401을 못 본다. 파일로 남겨야 다음 CLI 실행에서 보인다.
  it('records a rejected refresh for the next CLI run to surface', async () => {
    writeConfig();
    await writeBundle({ v: 1, access: 'old', access_expires_at: nowSec() + 30, refresh: 'r1' });
    vi.stubGlobal('fetch', vi.fn(() => new Response('{"code":"invalid"}', { status: 401 })));

    const { resolveUploadContextWithRefresh } = await import(
      '../../plugin/hooks/lib/upload-context.mjs'
    );
    await resolveUploadContextWithRefresh({ source: 'codex', sessionId: 's1' });

    expect(existsSync(join(configDir, 'auth-failure.json'))).toBe(true);

    const { readAuthFailure } = await import('../../plugin/hooks/lib/auth-failure.mjs');
    expect(readAuthFailure()).toMatchObject({ source: 'codex' });
  });
});
