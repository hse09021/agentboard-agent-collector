/**
 * End-to-end check of the multi-server path, against a stub server.
 *
 * Covers the sequence that actually matters in production: enroll against an
 * organization server, persist the binding, then confirm that sessions in that
 * directory route there while everything else keeps going to the community
 * server. Kept as a stub rather than a mock so the same file can be pointed at
 * a real server once one exists.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";

import { loadConfigV2, saveConfigV2, addBinding, generateCredentialRef } from "../../src/core/bindings";
import { saveCredential, loadCredential, listCredentialRefs, deleteCredential } from "../../src/platform/credential-store";
import { resolveRoute, DEFAULT_ROUTE_ID } from "../../src/core/routing";
import { decodeJwtClaims } from "../../src/core/jwt";

function makeTicket(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.stub-signature`;
}

interface Stub {
  url: string;
  close: () => Promise<void>;
  enrollments: Array<Record<string, unknown>>;
}

async function startStub(): Promise<Stub> {
  const enrollments: Array<Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/collector/enroll" && req.method === "POST") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ")) {
          res.writeHead(401).end(JSON.stringify({ error: "missing ticket" }));
          return;
        }
        enrollments.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            credential: makeTicket({ sub: "user-1", prj: "proj-1", exp: 2000000000 }),
            device_id: JSON.parse(body || "{}").device_id,
            server: { api_base_url: `http://127.0.0.1:${port}`, app_base_url: `http://127.0.0.1:${port}`, label: "Acme Internal" },
            project: { id: "proj-1", display_name: "Billing API" },
          })
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    enrollments,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("connect + routing against a stub server", () => {
  let configDir: string;
  let projectDir: string;
  let personalDir: string;
  let stub: Stub;

  beforeEach(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-e2e-")));
    configDir = path.join(root, "config");
    projectDir = path.join(root, "billing-api");
    personalDir = path.join(root, "side-project");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });

    process.env.AGENTBOARD_CONFIG_DIR = configDir;
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
    delete process.env.AGENTBOARD_CONFIG_DIR;
  });

  it("enrolls, stores a credential, and routes only the connected directory", async () => {
    const ticket = makeTicket({
      typ: "agentboard-enroll",
      iss: stub.url,
      api: stub.url,
      sub: "user-1",
      prj: "proj-1",
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    // The ticket is what tells the collector where to go — no separate
    // "add server" step exists.
    const claims = decodeJwtClaims(ticket);
    expect(claims?.api).toBe(stub.url);

    const response = await fetch(`${stub.url}/v1/collector/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ticket}` },
      body: JSON.stringify({ device_id: "dev_e2e", collector_version: "0.7.0" }),
    });
    expect(response.ok).toBe(true);
    const enrolled = (await response.json()) as {
      credential: string;
      server: { api_base_url: string; label: string };
      project: { display_name: string };
    };

    const ref = generateCredentialRef();
    saveCredential(ref, enrolled.credential);

    const { config } = addBinding(loadConfigV2(), {
      dir: projectDir,
      server: {
        api_base_url: enrolled.server.api_base_url,
        app_base_url: enrolled.server.api_base_url,
        label: enrolled.server.label,
        device_id: "dev_e2e",
      },
      credentialRef: ref,
      projectLabel: enrolled.project.display_name,
    });
    saveConfigV2(config);

    // Reload from disk: this is what the hook runtime sees.
    const saved = loadConfigV2();
    expect(saved.version).toBe(2);
    expect(saved.bindings).toHaveLength(1);
    expect(loadCredential(ref)).toBe(enrolled.credential);

    // Work in the connected project goes to the organization server...
    const work = resolveRoute({ config: saved, cwd: path.join(projectDir, "src") });
    expect(work).toMatchObject({ kind: "send", routeId: ref });
    if (work.kind === "send") expect(work.server.api_base_url).toBe(stub.url);

    // ...and a personal project on the same machine does not.
    const personal = resolveRoute({ config: saved, cwd: personalDir });
    expect(personal).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID, credentialRef: null });
    if (personal.kind === "send") {
      expect(personal.server.api_base_url).toContain("agentboard.cloud");
    }

    // The downgrade mirror must keep pointing at the community server, or
    // rolling back to v0.6.x would upload everything to the organization.
    expect(saved.api_base_url).toContain("agentboard.cloud");
  });

  it("removes the credential when a directory is disconnected", async () => {
    const ref = generateCredentialRef();
    saveCredential(ref, "cred-value");
    const { config } = addBinding(loadConfigV2(), {
      dir: projectDir,
      server: { api_base_url: stub.url, app_base_url: stub.url, device_id: "dev_e2e" },
      credentialRef: ref,
    });
    saveConfigV2(config);
    expect(listCredentialRefs()).toContain(ref);

    const { removeBinding } = await import("../../src/core/bindings");
    const { config: next, removed } = removeBinding(loadConfigV2(), projectDir);
    saveConfigV2(next);
    deleteCredential(removed!.credential_ref);

    expect(loadConfigV2().bindings).toHaveLength(0);
    expect(listCredentialRefs()).not.toContain(ref);
    expect(resolveRoute({ config: loadConfigV2(), cwd: projectDir })).toMatchObject({
      routeId: DEFAULT_ROUTE_ID,
    });
  });
});
