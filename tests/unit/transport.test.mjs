/**
 * Exercises uploadEvents against a real HTTP server.
 *
 * These exist because 0.7.0 shipped with `let body` shadowing the request
 * payload of the same name, which put the outer binding in the temporal dead
 * zone for the whole block — including the fetch() that read it. Every upload
 * failed with "Cannot access 'body' before initialization".
 *
 * The classifier had unit tests; the function that calls it did not. Anything
 * that only tests the pure helper would have missed this, so these tests drive
 * the transport itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { uploadEvents, registerDevice } from '../../plugin/hooks/lib/transport.mjs';

function makeEvent(id) {
  return {
    schema_version: '1.0',
    event_id: id,
    device_id: 'dev_test',
    source: 'claude_code',
    session_id: 'sess-1',
    started_at: new Date().toISOString(),
    total_tokens: 100,
    collector_version: '0.7.0',
  };
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, body: raw, headers: req.headers });
      handler(req, res, raw);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const json = (res, status, payload) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));

describe('uploadEvents', () => {
  let stub;
  afterEach(async () => {
    if (stub) await stub.close();
    stub = null;
  });

  it('sends the batch and returns the server verdict', async () => {
    stub = await startServer((req, res) =>
      json(res, 200, { accepted: 2, duplicates: 0, rejected: 0, results: [] })
    );

    const verdict = await uploadEvents(stub.url, 'tok', 'dev_test', [
      makeEvent('e1'),
      makeEvent('e2'),
    ]);

    expect(verdict.accepted).toBe(2);
    expect(verdict.canAdvanceLedger).toBe(true);

    // The request payload must actually have been sent — the shadowing bug
    // meant the fetch never happened at all.
    const sent = JSON.parse(stub.requests[0].body);
    expect(sent.device_id).toBe('dev_test');
    expect(sent.events).toHaveLength(2);
    expect(stub.requests[0].url).toBe('/v1/events/usage/batch');
    expect(stub.requests[0].headers.authorization).toBe('Bearer tok');
  });

  it('treats an empty 200 body as full success, for older servers', async () => {
    stub = await startServer((req, res) => res.writeHead(200).end());
    const verdict = await uploadEvents(stub.url, 'tok', 'dev_test', [makeEvent('e1')]);
    expect(verdict.canAdvanceLedger).toBe(true);
    expect(verdict.parsed).toBe(false);
  });

  it('holds the ledger when the server rejects retriably', async () => {
    stub = await startServer((req, res) =>
      json(res, 200, {
        accepted: 0,
        duplicates: 0,
        rejected: 1,
        results: [{ event_id: 'e1', status: 'rejected', reason: 'revoked_device' }],
      })
    );

    const verdict = await uploadEvents(stub.url, 'tok', 'dev_test', [makeEvent('e1')]);
    expect(verdict.canAdvanceLedger).toBe(false);
  });

  it('gives up on permanent rejections but records them', async () => {
    stub = await startServer((req, res) =>
      json(res, 200, {
        accepted: 1,
        duplicates: 0,
        rejected: 1,
        results: [
          { event_id: 'e1', status: 'accepted' },
          { event_id: 'e2', status: 'rejected', reason: 'invalid_schema' },
        ],
      })
    );

    const verdict = await uploadEvents(stub.url, 'tok', 'dev_test', [
      makeEvent('e1'),
      makeEvent('e2'),
    ]);
    expect(verdict.canAdvanceLedger).toBe(true);
    expect(verdict.reasons.invalid_schema).toBe(1);
  });

  it('surfaces the server code on a 404 so the caller can re-register', async () => {
    stub = await startServer((req, res) =>
      json(res, 404, { error: 'Device not found', code: 'device_not_found' })
    );

    await expect(
      uploadEvents(stub.url, 'tok', 'dev_test', [makeEvent('e1')])
    ).rejects.toThrow(/device_not_found/);
  });

  it('retries a transient status once', async () => {
    let calls = 0;
    stub = await startServer((req, res) => {
      calls++;
      if (calls === 1) return res.writeHead(503).end('busy');
      json(res, 200, { accepted: 1, duplicates: 0, rejected: 0, results: [] });
    });

    const verdict = await uploadEvents(stub.url, 'tok', 'dev_test', [makeEvent('e1')]);
    expect(calls).toBe(2);
    expect(verdict.accepted).toBe(1);
  });

  it('does nothing for an empty batch', async () => {
    const verdict = await uploadEvents('http://127.0.0.1:1', 'tok', 'dev_test', []);
    expect(verdict.canAdvanceLedger).toBe(true);
  });
});

describe('registerDevice', () => {
  let stub;
  afterEach(async () => {
    if (stub) await stub.close();
    stub = null;
  });

  it('posts the device and reports success', async () => {
    stub = await startServer((req, res) => json(res, 200, { device_id: 'dev_test', registered: true }));

    const ok = await registerDevice(stub.url, 'tok', 'dev_test', { os: 'windows' });

    expect(ok).toBe(true);
    expect(stub.requests[0].url).toBe('/v1/collector/devices');
    const sent = JSON.parse(stub.requests[0].body);
    expect(sent.device_id).toBe('dev_test');
    expect(sent.os).toBe('windows');
  });

  // The caller treats this as "could not recover this time", so it must never
  // throw out of the hook.
  it('returns false instead of throwing when the server refuses', async () => {
    stub = await startServer((req, res) => json(res, 403, { code: 'revoked_device' }));
    await expect(registerDevice(stub.url, 'tok', 'dev_test')).resolves.toBe(false);
  });

  it('returns false when the host is unreachable', async () => {
    await expect(registerDevice('http://127.0.0.1:1', 'tok', 'dev_test')).resolves.toBe(false);
  });
});
