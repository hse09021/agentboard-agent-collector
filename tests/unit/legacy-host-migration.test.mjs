/**
 * Tests for the agentboard.kro.kr → agentboard.cloud host migration in
 * plugin/hooks/lib/config.mjs.
 *
 * A saved ~/.agentboard/config.json always wins over DEFAULT_API_URL, so an
 * install that logged in before the domain move carries the dead host forever.
 * These tests prove the host is rewritten on read, that the path is preserved,
 * and that no other host is touched.
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
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-migrate-test-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('AGENTBOARD_API_URL', undefined);
  vi.resetModules();
  config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeConfig(apiBaseUrl) {
  writeFileSync(
    config.CONFIG_PATH,
    JSON.stringify({ device_id: 'dev_test', api_base_url: apiBaseUrl })
  );
}

describe('legacy host migration', () => {
  it('rewrites a saved kro.kr API URL to the current host', () => {
    writeConfig('https://agentboard.kro.kr/api/proxy');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'https://agentboard.cloud/api/proxy'
    );
  });

  it('rewrites the www variant too', () => {
    writeConfig('https://www.agentboard.kro.kr/api/proxy');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'https://agentboard.cloud/api/proxy'
    );
  });

  it('upgrades a plain-http legacy URL to https', () => {
    writeConfig('http://agentboard.kro.kr/api/proxy');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'https://agentboard.cloud/api/proxy'
    );
  });

  it('leaves a self-hosted or dev URL alone', () => {
    writeConfig('http://localhost:3000/api/proxy');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'http://localhost:3000/api/proxy'
    );
  });

  it('leaves an already-migrated URL alone', () => {
    writeConfig('https://agentboard.cloud/api/proxy');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'https://agentboard.cloud/api/proxy'
    );
  });

  it('falls back to the current-host default when no config exists', () => {
    expect(config.getApiBaseUrl(config.loadConfig())).toBe(
      'https://agentboard.cloud/api/proxy'
    );
  });

  it('does not throw on a malformed saved URL', () => {
    writeConfig('not-a-url');

    expect(config.getApiBaseUrl(config.loadConfig())).toBe('not-a-url');
  });
});
