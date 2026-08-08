/**
 * Tests for the agentboard.kro.kr → agentboard.cloud host migration in
 * src/core/config.ts (the CLI half of the deliberate config duplication —
 * plugin/hooks/lib/config.mjs carries the same logic for the hook runtime).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let homeDir: string;
let config: typeof import("../../src/core/config");

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "agentboard-cli-migrate-test-"));
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("APPDATA", join(homeDir, "AppData", "Roaming"));
  vi.stubEnv("AGENTBOARD_API_URL", undefined);
  vi.stubEnv("AGENTBOARD_APP_URL", undefined);
  vi.resetModules();
  config = await import("../../src/core/config");
  mkdirSync(config.getConfigDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeConfig(patch: Record<string, string>) {
  writeFileSync(config.getConfigPath(), JSON.stringify(patch));
}

describe("loadConfig legacy host migration", () => {
  it("rewrites both saved URLs off the retired host", () => {
    writeConfig({
      api_base_url: "https://agentboard.kro.kr/api/proxy",
      app_base_url: "https://agentboard.kro.kr",
    });

    const loaded = config.loadConfig();

    expect(loaded.api_base_url).toBe("https://agentboard.cloud/api/proxy");
    expect(loaded.app_base_url).toBe("https://agentboard.cloud");
  });

  it("leaves a self-hosted URL alone", () => {
    writeConfig({
      api_base_url: "http://localhost:3000/api/proxy",
      app_base_url: "http://localhost:3000",
    });

    const loaded = config.loadConfig();

    expect(loaded.api_base_url).toBe("http://localhost:3000/api/proxy");
    expect(loaded.app_base_url).toBe("http://localhost:3000");
  });

  it("persists the migration once the CLI next saves the config", () => {
    writeConfig({ api_base_url: "https://agentboard.kro.kr/api/proxy" });

    config.saveConfig({ device_id: "dev_test" });

    expect(config.loadConfig().api_base_url).toBe(
      "https://agentboard.cloud/api/proxy"
    );
    const onDisk = JSON.parse(readFileSync(config.getConfigPath(), "utf-8"));
    expect(onDisk.api_base_url).toBe("https://agentboard.cloud/api/proxy");
  });

  it("defaults to the current host with no saved config", () => {
    const loaded = config.loadConfig();

    expect(loaded.api_base_url).toBe("https://agentboard.cloud/api/proxy");
    expect(loaded.app_base_url).toBe("https://agentboard.cloud");
  });
});
