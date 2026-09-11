/**
 * Privacy guarantees for the cross-agent sweep.
 *
 * The sweep widens what gets collected — it reaches sessions belonging to
 * agents whose own config home has no agentboard hooks. Two invariants keep
 * that inside the project's stated principle of minimal collection and minimal
 * storage, and both are asserted here rather than left to review:
 *
 *   1. Nothing new leaves the machine. Every event the sweep hands the uploader
 *      carries the same fields the direct hooks send, and passes the forbidden-
 *      field guard.
 *   2. Nothing path-shaped is written to disk. A transcript path carries the
 *      repo name in plain text (…/projects/c--Users-alice-work-acme-billing/…),
 *      and `path`/`file_path`/`repo` are on this project's own forbidden-key
 *      list — so the scan cache stores a hash and never the path itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SECRET_SEGMENTS = ['acme-billing', 'secret-repo', 'alice'];
const SECRET_CWD = '/Users/alice/work/acme-billing';

let homeDir;
let scanCache;
let sweep;
let guard;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'agentboard-sweep-privacy-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'));
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.resetModules();

  const config = await import('../../plugin/hooks/lib/config.mjs');
  mkdirSync(config.CONFIG_DIR, { recursive: true });
  writeFileSync(
    config.CONFIG_PATH,
    JSON.stringify({
      version: 2,
      device_id: 'dev-1',
      default_server: {
        api_base_url: 'https://example.invalid/api',
        app_base_url: 'https://example.invalid',
        device_id: 'dev-1',
      },
      bindings: [],
    })
  );
  writeFileSync(config.TOKEN_PATH, 'token');

  scanCache = await import('../../plugin/hooks/lib/scan-cache.mjs');
  sweep = await import('../../plugin/hooks/lib/sweep.mjs');
  guard = await import('../../plugin/hooks/lib/forbidden-data-guard.mjs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeCodexSession(sessionId, cwd) {
  const day = new Date();
  const dir = join(
    homeDir,
    '.codex',
    'sessions',
    String(day.getUTCFullYear()),
    String(day.getUTCMonth() + 1).padStart(2, '0'),
    String(day.getUTCDate()).padStart(2, '0')
  );
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: 'session_meta', timestamp: ts, payload: { id: sessionId, cwd, model: 'gpt-5.5' } },
    {
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 400, output_tokens: 120, cached_input_tokens: 100 } },
      },
    },
  ];
  const file = join(dir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('uploaded events', () => {
  it('carry no forbidden field, and no cwd, even though routing read one', async () => {
    writeCodexSession('11111111-2222-3333-4444-555555555555', SECRET_CWD);

    const sent = [];
    await sweep.runSweep({
      uploader: async (_api, _token, _device, events) => {
        sent.push(...events);
        return { parsed: true, canAdvanceLedger: true };
      },
    });

    expect(sent.length).toBeGreaterThan(0);
    for (const event of sent) {
      expect(() => guard.assertNoForbiddenFields(event)).not.toThrow();
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(SECRET_CWD);
      for (const segment of SECRET_SEGMENTS) {
        expect(serialized).not.toContain(segment);
      }
    }
  });
});

describe('scan cache on disk', () => {
  it('contains no path, basename, or directory name', () => {
    const secretPath = `/Users/alice/.claude/projects/c--Users-alice-work-acme-billing/${'a'.repeat(8)}.jsonl`;
    const cache = scanCache.loadScanCache();
    scanCache.rememberScan(cache, secretPath, { mtimeMs: 1, size: 2 }, { sid: 'sess-1' });
    scanCache.saveScanCache(cache);

    const raw = readFileSync(scanCache.SWEEP_CACHE_PATH, 'utf-8');
    expect(raw).not.toContain(secretPath);
    expect(raw).not.toContain('acme-billing');
    expect(raw).not.toContain('projects');
    expect(raw).not.toContain('.jsonl');
    for (const segment of SECRET_SEGMENTS) {
      expect(raw).not.toContain(segment);
    }
  });

  it('passes the forbidden-field guard when loaded back', () => {
    const cache = scanCache.loadScanCache();
    scanCache.rememberScan(cache, '/Users/alice/secret-repo/x.jsonl', { mtimeMs: 1, size: 2 });
    scanCache.saveScanCache(cache);

    expect(() => guard.assertNoForbiddenFields(scanCache.loadScanCache())).not.toThrow();
  });
});

describe('agent-homes registry on disk', () => {
  it('stores tool config roots but never a project path', async () => {
    const homes = await import('../../plugin/hooks/lib/agent-homes.mjs');
    const codexHome = join(homeDir, '.codex');
    mkdirSync(codexHome, { recursive: true });
    homes.recordAgentHome('codex', codexHome, 'install');

    const raw = readFileSync(homes.AGENT_HOMES_PATH, 'utf-8');
    expect(raw).toContain('.codex');
    for (const segment of SECRET_SEGMENTS) {
      expect(raw).not.toContain(segment);
    }
  });
});
