/**
 * looksLikeAgentHome / discoverInstallTargets — which homes install-hooks is
 * allowed to write into.
 *
 * The guard exists so install-hooks never CREATES an agent home in an arbitrary
 * directory. But a freshly added Orca account has only credentials in it —
 * Claude's has no settings.json and no projects/ — so a content-only check
 * refuses to instrument exactly the home that most needs it, and that account's
 * first session goes uncollected until a sweep catches up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let homeDir: string;
let mod: typeof import("../../src/core/agent-homes");

async function reimport() {
  vi.resetModules();
  mod = await import("../../src/core/agent-homes");
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "agentboard-install-targets-"));
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir);
  vi.stubEnv("APPDATA", join(homeDir, "AppData", "Roaming"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", join(homeDir, "cfg"));
  vi.stubEnv("CODEX_HOME", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  mkdirSync(join(homeDir, "cfg"), { recursive: true });
  await reimport();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function orcaAccount(kind: "codex" | "claude_code", id: string) {
  const [dir, leaf, marker] =
    kind === "codex"
      ? ["codex-accounts", "home", ".orca-managed-home"]
      : ["claude-accounts", "auth", ".orca-managed-claude-auth"];
  const home = join(homeDir, "AppData", "Roaming", "Orca", dir, id, leaf);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, marker), id + "\n");
  return home;
}

describe("looksLikeAgentHome", () => {
  it("accepts a brand-new Orca account that has only its marker", () => {
    const claude = orcaAccount("claude_code", "a1");
    const codex = orcaAccount("codex", "c1");

    expect(mod.looksLikeAgentHome("claude_code", claude)).toBe(true);
    expect(mod.looksLikeAgentHome("codex", codex)).toBe(true);
  });

  it("still accepts a home identified by its contents", () => {
    const dir = join(homeDir, "plain-claude");
    mkdirSync(join(dir, "projects"), { recursive: true });
    expect(mod.looksLikeAgentHome("claude_code", dir)).toBe(true);
  });

  it("refuses a directory that is neither", () => {
    const dir = join(homeDir, "random");
    mkdirSync(dir, { recursive: true });
    expect(mod.looksLikeAgentHome("claude_code", dir)).toBe(false);
    expect(mod.looksLikeAgentHome("codex", dir)).toBe(false);
  });

  it("refuses a directory that does not exist", () => {
    expect(mod.looksLikeAgentHome("codex", join(homeDir, "gone"))).toBe(false);
  });
});

describe("discoverInstallTargets", () => {
  it("includes a new Orca account alongside the default home", async () => {
    orcaAccount("claude_code", "a1");
    await reimport();

    const targets = mod.discoverInstallTargets("claude_code");
    expect(targets.some((t) => t.origin === "orca")).toBe(true);
    expect(targets.some((t) => t.origin === "default")).toBe(true);
  });

  it("never returns a directory that is not already an agent home", async () => {
    const bogus = join(homeDir, "not-an-agent-home");
    mkdirSync(bogus, { recursive: true });
    await reimport();

    expect(mod.discoverInstallTargets("codex", { extraDirs: [bogus] })).not.toContainEqual(
      expect.objectContaining({ dir: bogus })
    );
  });
});
