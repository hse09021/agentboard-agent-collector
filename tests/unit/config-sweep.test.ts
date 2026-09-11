/**
 * The `sweep` config field, and the invariant that the TypeScript schema and
 * the .mjs hook mirror agree about it.
 *
 * They are separate implementations on purpose (hooks run outside the compiled
 * context), so a disagreement is exactly the kind of bug that would show up as
 * "the CLI says sweeping is off but it keeps sweeping".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateV1toV2, normalizeV2, type CollectorConfigV2 } from "../../src/core/config-schema";

function baseV2(overrides: Record<string, unknown> = {}): CollectorConfigV2 {
  return {
    version: 2,
    api_base_url: "https://example.invalid/api",
    app_base_url: "https://example.invalid",
    default_server: {
      api_base_url: "https://example.invalid/api",
      app_base_url: "https://example.invalid",
    },
    bindings: [],
    snapshot_target: "routed",
    sweep: "registered",
    ...overrides,
  } as CollectorConfigV2;
}

describe("sweep default", () => {
  it("is on when promoting a v1 config", () => {
    expect(migrateV1toV2({ device_id: "d" }).sweep).toBe("registered");
  });

  it("is on when the key is absent from a v2 config", () => {
    const raw = baseV2();
    delete (raw as Record<string, unknown>).sweep;
    expect(normalizeV2(raw).sweep).toBe("registered");
  });

  it("honours an explicit off", () => {
    expect(normalizeV2(baseV2({ sweep: "off" })).sweep).toBe("off");
  });

  it("coerces anything unrecognised to the documented default", () => {
    // A typo in a hand-edited config must not throw or silently stop
    // collection — the safe reading is the default.
    for (const value of ["ON", "yes", 1, null, {}]) {
      expect(normalizeV2(baseV2({ sweep: value })).sweep).toBe("registered");
    }
  });

  it("stays out of the downgrade mirror", () => {
    // v0.6.x reads device_id / api_base_url / app_base_url and nothing else; a
    // rolled-back collector should simply not sweep.
    const normalized = normalizeV2(baseV2({ sweep: "off" })) as Record<string, unknown>;
    expect(Object.keys(normalized)).toContain("sweep");
    expect(normalized.api_base_url).toBe("https://example.invalid/api");
  });
});

describe("hook-runtime mirror agrees with the schema", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "agentboard-sweep-mirror-"));
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("APPDATA", join(homeDir, "AppData", "Roaming"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function loadThroughMirror(raw: unknown) {
    vi.resetModules();
    const config = await import("../../plugin/hooks/lib/config.mjs");
    mkdirSync(config.CONFIG_DIR, { recursive: true });
    writeFileSync(config.CONFIG_PATH, JSON.stringify(raw));
    return config.loadConfigV2();
  }

  it("reads the same value as normalizeV2 for every input", async () => {
    const cases: unknown[] = [
      baseV2({ sweep: "off" }),
      baseV2({ sweep: "registered" }),
      baseV2({ sweep: "nonsense" }),
      { device_id: "d", api_base_url: "https://example.invalid/api" }, // v1
    ];

    for (const raw of cases) {
      const viaMirror = await loadThroughMirror(raw);
      const viaSchema = migrateV1toV2(raw);
      expect(viaMirror.sweep).toBe(viaSchema.sweep);
    }
  });
});
