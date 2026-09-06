import { describe, it, expect } from "vitest";
import {
  CONFIG_VERSION,
  DEFAULT_API_URL,
  migrateV1toV2,
  normalizeV2,
  isV2,
} from "../../src/core/config-schema";

describe("migrateV1toV2", () => {
  it("promotes a SaaS v1 config into a default server", () => {
    const v2 = migrateV1toV2(
      {
        device_id: "dev_abc",
        api_base_url: "https://agentboard.cloud/api/proxy",
        app_base_url: "https://agentboard.cloud",
      },
      {}
    );

    expect(v2.version).toBe(CONFIG_VERSION);
    expect(v2.default_server.api_base_url).toBe("https://agentboard.cloud/api/proxy");
    expect(v2.default_server.device_id).toBe("dev_abc");
    expect(v2.bindings).toEqual([]);
    expect(v2.snapshot_target).toBe("routed");
  });

  // The regression this guards is severe: making the promoted URL depend on the
  // environment would send a self-hosted user's uploads to the SaaS default the
  // moment a hook fires, because hooks do not inherit the user's shell.
  it("keeps a self-hosted URL verbatim and ignores the environment", () => {
    const v2 = migrateV1toV2(
      {
        device_id: "dev_x",
        api_base_url: "https://agentboard.acme.internal/api",
        app_base_url: "https://agentboard.acme.internal",
      },
      { AGENTBOARD_API_URL: "https://agentboard.cloud/api/proxy" }
    );

    expect(v2.default_server.api_base_url).toBe("https://agentboard.acme.internal/api");
    expect(v2.api_base_url).toBe("https://agentboard.acme.internal/api");
  });

  it("uses the environment only when there is no saved config", () => {
    const v2 = migrateV1toV2({}, { AGENTBOARD_API_URL: "https://stub.local/api" });
    expect(v2.default_server.api_base_url).toBe("https://stub.local/api");
  });

  it("falls back to the built-in default with neither config nor env", () => {
    const v2 = migrateV1toV2(undefined, {});
    expect(v2.default_server.api_base_url).toBe(DEFAULT_API_URL);
  });

  it("still rewrites the dead kro.kr host", () => {
    const v2 = migrateV1toV2(
      { api_base_url: "https://agentboard.kro.kr/api/proxy" },
      {}
    );
    expect(v2.default_server.api_base_url).toContain("agentboard.cloud");
  });

  it("derives app_base_url from the api origin when v1 lacked it", () => {
    const v2 = migrateV1toV2({ api_base_url: "https://host.internal/api/proxy" }, {});
    expect(v2.default_server.app_base_url).toBe("https://host.internal");
  });

  it("is idempotent", () => {
    const once = migrateV1toV2({ device_id: "dev_1", api_base_url: "https://a.b/api" }, {});
    const twice = migrateV1toV2(once, {});
    expect(twice).toEqual(once);
  });

  // The hook runtime and the CLI both promote in memory, independently.
  it("gives the same result to two independent callers", () => {
    const v1 = { device_id: "dev_9", api_base_url: "https://acme.internal/api" };
    expect(migrateV1toV2(v1, {})).toEqual(migrateV1toV2({ ...v1 }, {}));
  });

  it("recognises an already-v2 config", () => {
    const v2 = migrateV1toV2({ api_base_url: "https://a.b/api" }, {});
    expect(isV2(v2)).toBe(true);
    expect(isV2({ api_base_url: "x" })).toBe(false);
  });
});

describe("downgrade safety", () => {
  // v0.6.x reads exactly these three keys. If they drift from default_server,
  // rolling the collector back redirects a self-hosted user to the SaaS host.
  it("keeps the flat mirror in sync with the default server", () => {
    const v2 = normalizeV2({
      version: CONFIG_VERSION,
      device_id: "stale",
      api_base_url: "https://stale/api",
      app_base_url: "https://stale",
      default_server: {
        api_base_url: "https://acme.internal/api",
        app_base_url: "https://acme.internal",
        device_id: "dev_fresh",
      },
      bindings: [],
      snapshot_target: "routed",
    });

    expect(v2.api_base_url).toBe("https://acme.internal/api");
    expect(v2.app_base_url).toBe("https://acme.internal");
    expect(v2.device_id).toBe("dev_fresh");
  });

  // A binding must never leak into the mirror: v0.6.x would then upload
  // everything to that organization's server.
  it("never mirrors a binding server", () => {
    const v2 = normalizeV2({
      version: CONFIG_VERSION,
      api_base_url: "https://agentboard.cloud/api/proxy",
      app_base_url: "https://agentboard.cloud",
      default_server: {
        api_base_url: "https://agentboard.cloud/api/proxy",
        app_base_url: "https://agentboard.cloud",
        device_id: "dev_default",
      },
      bindings: [
        {
          abs_dir: "/work/api",
          real_dir: "/work/api",
          server: {
            api_base_url: "https://acme.internal/api",
            app_base_url: "https://acme.internal",
            device_id: "dev_acme",
          },
          credential_ref: "ref1",
          connected_at: "2026-09-06T00:00:00.000Z",
        },
      ],
      snapshot_target: "routed",
    });

    expect(v2.api_base_url).toBe("https://agentboard.cloud/api/proxy");
    expect(v2.device_id).toBe("dev_default");
  });
});
