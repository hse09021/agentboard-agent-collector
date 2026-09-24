/**
 * One device per server, not per directory (#10).
 *
 * `connect` used to mint a fresh device id every time, so connecting two
 * directories to the same organization showed one machine as two devices.
 * The failure modes worth pinning:
 * - a second directory on the same server reuses the id; another server does
 *   not (ids must never let two server operators correlate the machine);
 * - URL spelling differences must not defeat the match;
 * - a reused id the server has revoked falls back to a fresh one, once;
 * - reconnecting a directory must not revoke the device it just enrolled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Binding, CollectorConfigV2 } from "../../src/core/config-schema";

const API = "https://agentboard.acme.internal/api/proxy";
const APP = "https://agentboard.acme.internal";
const DEVICE = "dev_6164fed5c92a4a09b40c936cfd6b2cc4";

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-reuse-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
});

function binding(dir: string, apiBaseUrl: string, deviceId: string | undefined, ref: string): Binding {
  return {
    abs_dir: dir,
    real_dir: dir,
    server: { api_base_url: apiBaseUrl, app_base_url: APP, device_id: deviceId },
    credential_ref: ref,
    connected_at: "2026-09-24T00:00:00.000Z",
  };
}

async function configWith(bindings: Binding[]): Promise<CollectorConfigV2> {
  const { migrateV1toV2 } = await import("../../src/core/config-schema");
  return { ...migrateV1toV2({ device_id: "dev_community" }), bindings };
}

describe("findDeviceIdForServer", () => {
  it("returns the id another directory already uses on that server", async () => {
    const { findDeviceIdForServer } = await import("../../src/core/bindings");
    const config = await configWith([binding("/work/a", API, DEVICE, "a")]);
    expect(findDeviceIdForServer(config, API)).toBe(DEVICE);
  });

  it("matches despite a trailing slash or the legacy host", async () => {
    const { findDeviceIdForServer } = await import("../../src/core/bindings");
    const legacy = await configWith([binding("/work/a", "http://agentboard.kro.kr/api/proxy", DEVICE, "a")]);
    expect(findDeviceIdForServer(legacy, "https://agentboard.cloud/api/proxy/")).toBe(DEVICE);

    const slashed = await configWith([binding("/work/a", `${API}/`, DEVICE, "a")]);
    expect(findDeviceIdForServer(slashed, API)).toBe(DEVICE);
  });

  it("never hands out another server's id, nor the community server's", async () => {
    const { findDeviceIdForServer } = await import("../../src/core/bindings");
    const config = await configWith([binding("/work/a", "https://other.example/api", DEVICE, "a")]);
    expect(findDeviceIdForServer(config, API)).toBeUndefined();
    expect(findDeviceIdForServer(config, config.default_server.api_base_url)).toBeUndefined();
  });

  it("skips bindings saved without a device id", async () => {
    const { findDeviceIdForServer } = await import("../../src/core/bindings");
    const config = await configWith([binding("/work/a", API, undefined, "a"), binding("/work/b", API, DEVICE, "b")]);
    expect(findDeviceIdForServer(config, API)).toBe(DEVICE);
  });
});

describe("enrollDevice", () => {
  const enrolled = (id: string) => ({ credential: "cred", device_id: id });

  it("reuses the id this machine already has on the server", async () => {
    const { enrollDevice } = await import("../../src/cli/commands/connect");
    const enroll = vi.fn(async (_api: string, _t: string, id: string) => enrolled(id));

    const out = await enrollDevice(API, "ticket", await configWith([binding("/work/a", API, DEVICE, "a")]), enroll);

    expect(out.deviceId).toBe(DEVICE);
    expect(out.revokedDeviceId).toBeUndefined();
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(enroll).toHaveBeenCalledWith(API, "ticket", DEVICE);
  });

  it("mints a fresh id for a server this machine is not connected to", async () => {
    const { enrollDevice } = await import("../../src/cli/commands/connect");
    const enroll = vi.fn(async (_api: string, _t: string, id: string) => enrolled(id));

    const out = await enrollDevice(API, "ticket", await configWith([binding("/work/a", "https://other.example/api", DEVICE, "a")]), enroll);

    expect(out.deviceId).toMatch(/^dev_[0-9a-f]{32}$/);
    expect(out.deviceId).not.toBe(DEVICE);
  });

  it("comes back as a new device, once, when the reused id was revoked", async () => {
    const { enrollDevice } = await import("../../src/cli/commands/connect");
    const { ApiError } = await import("../../src/api/client");
    const enroll = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(403, '{"code":"revoked_device"}', "revoked_device"))
      .mockImplementation(async (_api: string, _t: string, id: string) => enrolled(id));

    const out = await enrollDevice(API, "ticket", await configWith([binding("/work/a", API, DEVICE, "a")]), enroll);

    expect(out.revokedDeviceId).toBe(DEVICE);
    expect(out.deviceId).not.toBe(DEVICE);
    expect(enroll).toHaveBeenCalledTimes(2);
    expect(enroll.mock.calls[1][2]).toBe(out.deviceId);
  });

  it("does not retry any other rejection", async () => {
    const { enrollDevice } = await import("../../src/cli/commands/connect");
    const { ApiError } = await import("../../src/api/client");
    const enroll = vi.fn().mockRejectedValue(new ApiError(401, "{}", undefined));

    await expect(
      enrollDevice(API, "ticket", await configWith([binding("/work/a", API, DEVICE, "a")]), enroll)
    ).rejects.toBeInstanceOf(ApiError);
    expect(enroll).toHaveBeenCalledTimes(1);
  });
});

describe("reconnecting a directory", () => {
  it("does not revoke the device the new connection just enrolled with", async () => {
    const { addBinding } = await import("../../src/core/bindings");
    const { retireBinding } = await import("../../src/core/retire-binding");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-project-"));
    try {
      const first = addBinding(await configWith([]), {
        dir,
        server: { api_base_url: API, app_base_url: APP, device_id: DEVICE },
        credentialRef: "old",
      });
      // Same server, so enrollDevice hands back the same id.
      const second = addBinding(first.config, {
        dir,
        server: { api_base_url: API, app_base_url: APP, device_id: DEVICE },
        credentialRef: "new",
      });
      expect(second.replaced?.credential_ref).toBe("old");

      const deps = { loadCredential: vi.fn().mockReturnValue("cred"), deleteCredential: vi.fn(), notify: vi.fn() };
      const notice = await retireBinding(second.replaced!, second.config.bindings, deps);

      expect(notice).toEqual({ ok: true, kept: "shared", sharedWith: 1 });
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.deleteCredential).toHaveBeenCalledWith("old");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
