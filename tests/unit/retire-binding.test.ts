/**
 * Retiring a connection (0.10.0): `disconnect`, and `connect` replacing an
 * existing connection for the same directory, tell the organization server to
 * revoke the device instead of only deleting the local credential.
 *
 * The failure modes worth pinning:
 * - the notice is best-effort: a dead network or an older server (404) must
 *   never block or undo a local disconnect;
 * - local state is saved BEFORE the server is told, otherwise a failed config
 *   write leaves hooks uploading with a credential the server just revoked;
 * - the local credential is deleted whether or not the notice landed;
 * - a device still used by another directory on the same server is kept.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let configDir: string;
let projectDir: string;
const API = "https://agentboard.acme.internal/api/proxy";
const APP = "https://agentboard.acme.internal";
const DEVICE = "dev_6164fed5c92a4a09b40c936cfd6b2cc4";
const CREDENTIAL = "header.payload.signature";

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-retire-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-project-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function okResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("notifyDeviceDisconnected", () => {
  it("POSTs the device id to /v1/collector/disconnect with the device credential", async () => {
    const { notifyDeviceDisconnected } = await import("../../src/api/project-device");
    const { COLLECTOR_VERSION } = await import("../../src/core/version");
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ revoked: 1 }));

    const notice = await notifyDeviceDisconnected(`${API}/`, CREDENTIAL, DEVICE, fetchImpl);

    expect(notice).toEqual({ ok: true, revoked: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/collector/disconnect`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(init.headers["User-Agent"]).toBe(`agentboard-collector/${COLLECTOR_VERSION}`);
    expect(JSON.parse(init.body)).toEqual({ device_id: DEVICE });
  });

  it("treats an already-revoked device as success (revoked: 0)", async () => {
    const { notifyDeviceDisconnected } = await import("../../src/api/project-device");
    const notice = await notifyDeviceDisconnected(API, CREDENTIAL, DEVICE, vi.fn().mockResolvedValue(okResponse({ revoked: 0 })));
    expect(notice).toEqual({ ok: true, revoked: 0 });
  });

  it("reports a server older than the endpoint (404) as not told, without throwing", async () => {
    const { notifyDeviceDisconnected } = await import("../../src/api/project-device");
    const notice = await notifyDeviceDisconnected(API, CREDENTIAL, DEVICE, vi.fn().mockResolvedValue(okResponse({}, 404)));
    expect(notice).toEqual({ ok: false, reason: "HTTP 404" });
  });

  it("reports a network failure without throwing", async () => {
    const { notifyDeviceDisconnected } = await import("../../src/api/project-device");
    const notice = await notifyDeviceDisconnected(API, CREDENTIAL, DEVICE, vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(notice).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });
});

describe("retireBinding", () => {
  const binding = {
    abs_dir: "/work/billing-api",
    real_dir: "/work/billing-api",
    server: { api_base_url: API, app_base_url: APP, label: "Acme", device_id: DEVICE },
    credential_ref: "0123456789abcdef",
    connected_at: "2026-09-12T21:10:08.668Z",
  };

  it("tells the server, then deletes the local credential", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const order: string[] = [];
    const deps = {
      loadCredential: vi.fn().mockReturnValue(CREDENTIAL),
      deleteCredential: vi.fn(() => void order.push("delete")),
      notify: vi.fn(async () => {
        order.push("notify");
        return { ok: true as const, revoked: 1 };
      }),
    };

    const notice = await retireBinding(binding, [], deps);

    expect(notice).toEqual({ ok: true, revoked: 1 });
    expect(deps.notify).toHaveBeenCalledWith(API, CREDENTIAL, DEVICE);
    expect(order).toEqual(["notify", "delete"]);
  });

  it("still deletes the local credential when the notice fails", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const deps = {
      loadCredential: vi.fn().mockReturnValue(CREDENTIAL),
      deleteCredential: vi.fn(),
      notify: vi.fn().mockResolvedValue({ ok: false, reason: "HTTP 503" }),
    };

    const notice = await retireBinding(binding, [], deps);

    expect(notice).toEqual({ ok: false, reason: "HTTP 503" });
    expect(deps.deleteCredential).toHaveBeenCalledWith(binding.credential_ref);
  });

  it("does not contact the server without a credential or device id", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const noCredential = { loadCredential: vi.fn().mockReturnValue(null), deleteCredential: vi.fn(), notify: vi.fn() };
    const noDevice = { loadCredential: vi.fn().mockReturnValue(CREDENTIAL), deleteCredential: vi.fn(), notify: vi.fn() };

    expect((await retireBinding(binding, [], noCredential)).ok).toBe(false);
    expect(
      (await retireBinding({ ...binding, server: { ...binding.server, device_id: undefined } }, [], noDevice)).ok
    ).toBe(false);

    expect(noCredential.notify).not.toHaveBeenCalled();
    expect(noDevice.notify).not.toHaveBeenCalled();
    expect(noCredential.deleteCredential).toHaveBeenCalled();
  });

  it("keeps the device when another connection to the same server still uses it", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const sibling = { ...binding, abs_dir: "/work/web", real_dir: "/work/web", credential_ref: "fedcba9876543210" };
    const deps = { loadCredential: vi.fn().mockReturnValue(CREDENTIAL), deleteCredential: vi.fn(), notify: vi.fn() };

    const notice = await retireBinding(binding, [sibling], deps);

    // ★ Revoking here would cut /work/web off its server too.
    expect(notice).toEqual({ ok: true, kept: "shared", sharedWith: 1 });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deleteCredential).toHaveBeenCalledWith(binding.credential_ref);
  });

  it("still revokes when the remaining connections use other devices or servers", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const otherDevice = { ...binding, credential_ref: "1", server: { ...binding.server, device_id: "dev_other" } };
    const otherServer = { ...binding, credential_ref: "2", server: { ...binding.server, api_base_url: "https://other.example/api" } };
    const deps = {
      loadCredential: vi.fn().mockReturnValue(CREDENTIAL),
      deleteCredential: vi.fn(),
      notify: vi.fn().mockResolvedValue({ ok: true, revoked: 1 }),
    };

    expect(await retireBinding(binding, [otherDevice, otherServer], deps)).toEqual({ ok: true, revoked: 1 });
    expect(deps.notify).toHaveBeenCalledWith(API, CREDENTIAL, DEVICE);
  });

  it("never throws, even if loading the credential does", async () => {
    const { retireBinding } = await import("../../src/core/retire-binding");
    const deps = {
      loadCredential: vi.fn(() => {
        throw new Error("EACCES");
      }),
      deleteCredential: vi.fn(),
      notify: vi.fn(),
    };
    await expect(retireBinding(binding, [], deps)).resolves.toEqual({ ok: false, reason: "EACCES" });
  });
});

describe("disconnectCommand", () => {
  async function connectFixture() {
    const bindings = await import("../../src/core/bindings");
    const store = await import("../../src/platform/credential-store");
    const ref = bindings.generateCredentialRef();
    store.saveCredential(ref, CREDENTIAL);
    const { config } = bindings.addBinding(bindings.loadConfigV2(), {
      dir: projectDir,
      server: { api_base_url: API, app_base_url: APP, label: "Acme", device_id: DEVICE },
      credentialRef: ref,
      projectLabel: "billing-api",
    });
    bindings.saveConfigV2(config);
    return { ref, bindings, store };
  }

  it("removes the connection locally, then revokes the device on its server", async () => {
    const { ref, store } = await connectFixture();
    const configPath = path.join(configDir, "config.json");
    let bindingsAtNotice: unknown[] | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // ★ The invariant: by the time the server is told, the binding is already
        //   gone from disk, so no hook can route to that server any more.
        bindingsAtNotice = JSON.parse(fs.readFileSync(configPath, "utf-8")).bindings;
        return okResponse({ revoked: 1 });
      })
    );

    const { disconnectCommand } = await import("../../src/cli/commands/connect");
    await disconnectCommand(projectDir);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${API}/v1/collector/disconnect`);
    expect(init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(bindingsAtNotice).toEqual([]);
    expect(store.loadCredential(ref)).toBeNull();
  });

  it("revokes the device only when the last directory on that server disconnects", async () => {
    const { ref, bindings, store } = await connectFixture();
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-project-"));
    const secondRef = bindings.generateCredentialRef();
    store.saveCredential(secondRef, CREDENTIAL);
    bindings.saveConfigV2(
      bindings.addBinding(bindings.loadConfigV2(), {
        dir: secondDir,
        server: { api_base_url: API, app_base_url: APP, label: "Acme", device_id: DEVICE },
        credentialRef: secondRef,
      }).config
    );
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ revoked: 1 })));
    const { disconnectCommand } = await import("../../src/cli/commands/connect");

    try {
      await disconnectCommand(projectDir);
      expect(fetch).not.toHaveBeenCalled();
      expect(store.loadCredential(ref)).toBeNull();
      expect(store.loadCredential(secondRef)).toBe(CREDENTIAL);

      await disconnectCommand(secondDir);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(bindings.loadConfigV2().bindings).toEqual([]);
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it("still disconnects locally when the server cannot be reached", async () => {
    const { ref, bindings, store } = await connectFixture();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { disconnectCommand } = await import("../../src/cli/commands/connect");
    await disconnectCommand(projectDir);

    expect(bindings.loadConfigV2().bindings).toEqual([]);
    expect(store.loadCredential(ref)).toBeNull();
  });
});
