/**
 * The default route's `.token` and a connected project's `.cred` belong to two
 * different servers, and now both rotate (#15). A token sent to the other
 * server is refused — but only after that server's operator has seen it. So
 * this runs the hooks' upload path against two real stub servers, from a
 * connected and an unconnected directory, through rotation, a 401 retry and a
 * legacy exchange, and checks that:
 *
 *   - each server only ever receives tokens it issued itself
 *   - rotating one route's token never changes the other route's file
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROJECT_REF = 'a1b2c3d4e5f60001';
const LEGACY_REF = 'a1b2c3d4e5f60002';

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.sig`;
}

/**
 * A server that mints its own tokens and records every credential presented
 * to it: the bearer, and any refresh token in the body.
 */
function startStub(name) {
  const issued = new Set();
  const liveRefresh = new Set();
  const revoked = new Set();
  const seen = [];
  let serial = 0;
  const stub = { name, issued, seen, rejectNextUpload: false, url: '' };

  const nowSec = () => Math.floor(Date.now() / 1000);
  stub.mintAccess = (secondsLeft = 3600, extra = {}) => {
    const exp = nowSec() + secondsLeft;
    const token = jwt({ iss: name, n: ++serial, iat: exp - 3600, exp, ...extra });
    issued.add(token);
    return token;
  };
  stub.mintRefresh = () => {
    const token = `${name}-refresh-${++serial}`;
    issued.add(token);
    liveRefresh.add(token);
    return token;
  };
  stub.mintLegacy = (daysLeft = 60) => {
    const exp = nowSec() + daysLeft * 86400;
    const token = jwt({ iss: name, n: ++serial, typ: 'legacy', iat: exp - 90 * 86400, exp });
    issued.add(token);
    return token;
  };
  stub.pair = (v) => {
    const access = stub.mintAccess();
    return { v, access, access_expires_at: nowSec() + 3600, refresh: stub.mintRefresh(), refresh_expires_at: nowSec() + 90 * 86400 };
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '') || null;
      if (bearer) seen.push({ path: req.url, token: bearer });
      if (body.refresh_token) seen.push({ path: req.url, token: body.refresh_token });

      const send = (status, payload) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload ?? {}));
      const rotate = (v) => {
        if (!liveRefresh.has(body.refresh_token)) return send(401, { code: 'invalid_refresh' });
        liveRefresh.delete(body.refresh_token);
        return send(200, stub.pair(v));
      };

      if (req.method !== 'POST') return send(404);
      if (name === 'default' && req.url === '/v1/auth/token/refresh') return rotate(1);
      if (name === 'org' && req.url === '/v1/collector/refresh') return rotate(2);
      if (name === 'org' && req.url === '/v1/collector/renew') {
        if (!issued.has(bearer) || revoked.has(bearer)) return send(401, { code: 'invalid_credential' });
        if (body.v !== 2) return send(200, { credential: stub.mintLegacy(90) });
        revoked.add(bearer); // the exchanged credential dies at once
        return send(200, { ...stub.pair(2), device_id: body.device_id });
      }
      if (req.url === '/v1/events/usage/batch') {
        if (!issued.has(bearer) || revoked.has(bearer)) return send(401, { code: 'invalid_token' });
        if (stub.rejectNextUpload) {
          stub.rejectNextUpload = false;
          return send(401, { code: 'invalid_token' });
        }
        return send(200, { accepted: body.events.length, duplicates: 0, rejected: 0, results: [] });
      }
      return send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      stub.url = `http://127.0.0.1:${server.address().port}`;
      stub.close = () => new Promise((r) => server.close(() => r()));
      resolve(stub);
    });
  });
}

let defaultServer;
let orgServer;
let configDir;
let workDir;

beforeAll(async () => {
  [defaultServer, orgServer] = await Promise.all([startStub('default'), startStub('org')]);
});

afterAll(async () => {
  await Promise.all([defaultServer.close(), orgServer.close()]);
});

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'agentboard-two-servers-'));
  workDir = mkdtempSync(join(tmpdir(), 'agentboard-two-servers-work-'));
  vi.stubEnv('AGENTBOARD_CONFIG_DIR', configDir);
  vi.stubEnv('AGENTBOARD_REFRESH_THRESHOLD_SECONDS', '');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const dirs = () => ({
  project: join(workDir, 'billing-api'),
  legacy: join(workDir, 'web'),
  personal: join(workDir, 'side-project'),
});

function setUp() {
  const d = dirs();
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const binding = (ref, dir) => ({
    credential_ref: ref,
    abs_dir: dir,
    real_dir: dir,
    project_label: ref,
    connected_at: '2026-10-01T00:00:00.000Z',
    server: { api_base_url: orgServer.url, app_base_url: orgServer.url, label: 'Acme', device_id: 'dev_org' },
  });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 2,
      device_id: 'dev_default',
      default_server: { api_base_url: defaultServer.url, app_base_url: defaultServer.url, device_id: 'dev_default' },
      bindings: [binding(PROJECT_REF, d.project), binding(LEGACY_REF, d.legacy)],
    }),
  );

  // Both routes start inside their rotation window.
  const nearExpiry = (stub) => {
    const access = stub.mintAccess(30);
    const exp = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp;
    return { access, access_expires_at: exp, refresh: stub.mintRefresh() };
  };
  writeFileSync(join(configDir, '.token'), JSON.stringify({ v: 1, ...nearExpiry(defaultServer) }), { mode: 0o600 });
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(join(configDir, 'credentials', `${PROJECT_REF}.cred`), JSON.stringify({ v: 2, ...nearExpiry(orgServer) }), {
    mode: 0o600,
  });
  writeFileSync(join(configDir, 'credentials', `${LEGACY_REF}.cred`), orgServer.mintLegacy(60), { mode: 0o600 });
  return d;
}

function snapshot() {
  const read = (p) => readFileSync(join(configDir, p), 'utf-8');
  const files = { '.token': read('.token') };
  for (const f of readdirSync(join(configDir, 'credentials')).filter((f) => f.endsWith('.cred'))) {
    files[f] = read(join('credentials', f));
  }
  return files;
}

/** Everything but `changed` is byte-identical. */
function expectOnlyChanged(before, after, changed) {
  for (const name of Object.keys(before)) {
    if (name === changed) expect(after[name], name).not.toBe(before[name]);
    else expect(after[name], name).toBe(before[name]);
  }
}

async function uploadFrom(cwd) {
  const { resolveUploadContextWithRefresh, uploadWithContext } = await import(
    '../../plugin/hooks/lib/upload-context.mjs'
  );
  const ctx = await resolveUploadContextWithRefresh({ source: 'codex', sessionId: `s-${Date.now()}`, cwd });
  expect(ctx.ok).toBe(true);
  return { ctx, verdict: await uploadWithContext(ctx, [{ event_id: 'e1', total_tokens: 1 }]) };
}

function expectOnlyOwnTokens() {
  for (const stub of [defaultServer, orgServer]) {
    const other = stub === defaultServer ? orgServer : defaultServer;
    for (const { path, token } of stub.seen) {
      expect(stub.issued.has(token), `${stub.name} received a token it never issued at ${path}`).toBe(true);
      expect(other.issued.has(token), `${stub.name} received ${other.name}'s token at ${path}`).toBe(false);
    }
  }
}

describe('two servers, two token stores', () => {
  it('keeps each route on its own server through rotation, a 401 retry and a legacy exchange', async () => {
    const d = setUp();
    const marks = () => ({ default: defaultServer.seen.length, org: orgServer.seen.length });
    const paths = (stub, from) => stub.seen.slice(from).map((s) => s.path);

    // 1. Unconnected directory: the default route rotates `.token` against the
    //    default server and uploads there. No `.cred` changes.
    let before = snapshot();
    let at = marks();
    let { ctx } = await uploadFrom(d.personal);
    expect(ctx.route.credentialRef).toBeNull();
    expect(ctx.apiBaseUrl).toBe(defaultServer.url);
    expect(paths(defaultServer, at.default)).toEqual(['/v1/auth/token/refresh', '/v1/events/usage/batch']);
    expect(paths(orgServer, at.org)).toEqual([]);
    expectOnlyChanged(before, snapshot(), '.token');

    // 2. Connected directory: the project's pair rotates against its own
    //    server. Its first upload is refused, so it rotates once more and
    //    retries once. `.token` never changes.
    orgServer.rejectNextUpload = true;
    before = snapshot();
    at = marks();
    ({ ctx } = await uploadFrom(d.project));
    expect(ctx.route.credentialRef).toBe(PROJECT_REF);
    expect(ctx.apiBaseUrl).toBe(orgServer.url);
    expect(paths(orgServer, at.org)).toEqual([
      '/v1/collector/refresh',
      '/v1/events/usage/batch',
      '/v1/collector/refresh',
      '/v1/events/usage/batch',
    ]);
    expect(paths(defaultServer, at.default)).toEqual([]);
    expectOnlyChanged(before, snapshot(), `${PROJECT_REF}.cred`);

    // 3. A legacy connection is exchanged for a pair on its first upload.
    before = snapshot();
    at = marks();
    ({ ctx } = await uploadFrom(d.legacy));
    expect(paths(orgServer, at.org)).toEqual(['/v1/collector/renew', '/v1/events/usage/batch']);
    expect(paths(defaultServer, at.default)).toEqual([]);
    expectOnlyChanged(before, snapshot(), `${LEGACY_REF}.cred`);
    expect(JSON.parse(snapshot()[`${LEGACY_REF}.cred`])).toMatchObject({ v: 2 });

    // 4. A 401 on the default route is not retried, and nothing reaches the
    //    organization's server because of it.
    defaultServer.rejectNextUpload = true;
    before = snapshot();
    at = marks();
    await expect(uploadFrom(d.personal)).rejects.toThrow(/HTTP 401/);
    expect(paths(orgServer, at.org)).toEqual([]);
    expect(snapshot()).toEqual(before);

    expectOnlyOwnTokens();
    // Neither side's lock was touched by the other.
    expect(readdirSync(configDir).filter((f) => f.endsWith('.lock'))).toEqual([]);
    expect(readdirSync(join(configDir, 'credentials')).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });
});
