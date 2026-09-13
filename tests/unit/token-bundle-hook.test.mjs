/**
 * Storage format as the HOOK reads it (plugin/hooks/lib/config.mjs).
 *
 * The hook cannot import the built TypeScript, so the parsing branch exists
 * twice. These tests pin the hook's copy to the same behaviour as the CLI's
 * (tests/unit/token-bundle.test.ts) — a divergence here means the hook and the
 * CLI disagree about whether the user is logged in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let configDir;
let config;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-hook-token-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function makeJwt(claims) {
  const b64 = (o) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}

describe('hook parseTokenFile', () => {
  it('promotes a legacy single JWT', () => {
    const jwt = makeJwt({ exp: 1_760_003_600 });
    expect(config.parseTokenFile(jwt)).toEqual({
      v: 1,
      access: jwt,
      access_expires_at: 1_760_003_600,
      refresh: null,
    });
  });

  it('reads the JSON bundle', () => {
    expect(
      config.parseTokenFile(
        JSON.stringify({ v: 1, access: 'acc', access_expires_at: 100, refresh: 'ref' }),
      ),
    ).toEqual({
      v: 1,
      access: 'acc',
      access_expires_at: 100,
      refresh: 'ref',
      refresh_expires_at: undefined,
    });
  });

  it('returns null for empty and truncated files', () => {
    expect(config.parseTokenFile('')).toBeNull();
    expect(config.parseTokenFile('{"access":"eyJ')).toBeNull();
  });
});

describe('hook loadToken / loadTokenBundle', () => {
  it('reads a legacy token file written by an older CLI', () => {
    const jwt = makeJwt({ exp: 1_760_003_600 });
    writeFileSync(join(configDir, '.token'), jwt + '\n');

    expect(config.loadToken()).toBe(jwt);
    expect(config.loadTokenBundle().refresh).toBeNull();
  });

  it('reads a bundle written by the CLI', () => {
    writeFileSync(
      join(configDir, '.token'),
      JSON.stringify({ v: 1, access: 'acc', refresh: 'ref' }),
    );

    expect(config.loadToken()).toBe('acc');
    expect(config.loadTokenBundle().refresh).toBe('ref');
  });

  // loadRouteCredential 은 기본 라우트(credentialRef 없음)일 때만 .token을 읽는다.
  it('loadRouteCredential falls back to the bundle for the default route', () => {
    writeFileSync(
      join(configDir, '.token'),
      JSON.stringify({ v: 1, access: 'acc', refresh: 'ref' }),
    );

    expect(config.loadRouteCredential(null)).toBe('acc');
  });

  it('saves atomically with 0600 and leaves no temp file', () => {
    config.saveTokenBundle({ v: 1, access: 'acc', refresh: 'ref' });

    expect(config.loadTokenBundle().access).toBe('acc');
    expect(readdirSync(configDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(statSync(join(configDir, '.token')).mode & 0o777).toBe(0o600);
    }
  });
});

describe('CLI and hook agree', () => {
  // 두 구현이 같은 바이트를 내놓지 않으면, 한쪽이 쓴 파일을 다른 쪽이 못 읽는
  // 순간이 언젠가 온다.
  it('serializes a bundle identically to the CLI', async () => {
    const cli = await import('../../src/platform/credential-store');
    const bundle = {
      v: 1,
      access: 'acc',
      access_expires_at: 100,
      refresh: 'ref',
      refresh_expires_at: 200,
    };

    expect(config.serializeTokenBundle(bundle)).toBe(cli.serializeTokenBundle(bundle));
  });

  it('parses a CLI-written file to the same result', async () => {
    const cli = await import('../../src/platform/credential-store');
    const jwt = makeJwt({ exp: 1_760_003_600, iat: 1_760_000_000 });

    for (const input of [
      jwt,
      JSON.stringify({ v: 1, access: 'acc', refresh: 'ref' }),
      '',
      '{"broken',
    ]) {
      expect(config.parseTokenFile(input)).toEqual(cli.parseTokenFile(input));
    }
  });
});
