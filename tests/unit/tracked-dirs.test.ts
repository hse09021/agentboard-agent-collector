/**
 * Collection scope config and the tracked-directory list behind
 * `agentboard scope|track|untrack` (#23).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONFIG_VERSION,
  migrateV1toV2,
  normalizeV2,
  type CollectorConfigV2,
} from "../../src/core/config-schema";
import {
  addTrackedDir,
  bindingCovering,
  defaultServerName,
  findTrackedDir,
  removeTrackedDir,
  setDefaultScope,
  trackedDirCovering,
} from "../../src/core/tracked-dirs";

let root: string;
let side: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-tracked-")));
  side = path.join(root, "side");
  fs.mkdirSync(path.join(side, "src"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function config(): CollectorConfigV2 {
  return migrateV1toV2({ api_base_url: "https://agentboard.cloud/api/proxy" });
}

describe("scope config", () => {
  // Existing installs keep sending everything, as before #23.
  it("defaults to all with nothing tracked", () => {
    expect(config()).toMatchObject({ default_scope: "all", tracked_dirs: [] });
    const saved = { version: CONFIG_VERSION, default_server: { api_base_url: "x", app_base_url: "y" }, bindings: [] };
    expect(normalizeV2(saved as unknown as CollectorConfigV2)).toMatchObject({ default_scope: "all", tracked_dirs: [] });
  });

  it("narrows only on an explicit listed", () => {
    const base = config();
    expect(normalizeV2({ ...base, default_scope: "listed" }).default_scope).toBe("listed");
    expect(normalizeV2({ ...base, default_scope: " Listed " as never }).default_scope).toBe("listed");
    expect(normalizeV2({ ...base, default_scope: "lsited" as never }).default_scope).toBe("all");
  });

  it("drops tracked entries that could never match", () => {
    const tracked = [
      { abs_dir: side, real_dir: side, added_at: "2026-11-24T00:00:00.000Z" },
      { abs_dir: "", real_dir: "", added_at: "2026-11-24T00:00:00.000Z" },
      { abs_dir: side },
      "nonsense",
    ];
    expect(normalizeV2({ ...config(), tracked_dirs: tracked as never }).tracked_dirs).toEqual([tracked[0]]);
  });
});

describe("tracked directories", () => {
  const NOW = new Date("2026-11-24T09:00:00.000Z");

  it("adds a directory with the moment it was added", () => {
    const { config: next, tracked, alreadyTracked } = addTrackedDir(config(), side, NOW);
    expect(alreadyTracked).toBe(false);
    expect(tracked).toEqual({ abs_dir: side, real_dir: side, added_at: NOW.toISOString() });
    expect(next.tracked_dirs).toEqual([tracked]);
  });

  // Re-tracking must not withhold usage that was meant to be sent.
  it("keeps the original added_at when a directory is tracked again", () => {
    const first = addTrackedDir(config(), side, NOW).config;
    const again = addTrackedDir(first, side, new Date("2026-11-25T00:00:00.000Z"));
    expect(again.alreadyTracked).toBe(true);
    expect(again.config.tracked_dirs).toHaveLength(1);
    expect(again.tracked.added_at).toBe(NOW.toISOString());
  });

  it("matches through a symlink", () => {
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(side, link, "junction");
    } catch {
      return;
    }
    const next = addTrackedDir(config(), link, NOW).config;
    expect(findTrackedDir(next, side)).toBeDefined();
  });

  it("removes exactly the directory, and reports a parent that covers a subdirectory", () => {
    const tracked = addTrackedDir(config(), side, NOW).config;
    const sub = path.join(side, "src");

    expect(removeTrackedDir(tracked, sub).removed).toBeUndefined();
    expect(trackedDirCovering(tracked, sub)?.abs_dir).toBe(side);

    const { config: next, removed } = removeTrackedDir(tracked, side);
    expect(removed?.abs_dir).toBe(side);
    expect(next.tracked_dirs).toEqual([]);
  });

  it("finds the connected project covering a directory", () => {
    const withBinding: CollectorConfigV2 = {
      ...config(),
      bindings: [
        {
          abs_dir: side,
          real_dir: side,
          credential_ref: "ref",
          connected_at: NOW.toISOString(),
          server: { api_base_url: "https://org/api", app_base_url: "https://org" },
        },
      ],
    };
    expect(bindingCovering(withBinding, path.join(side, "src"))?.credential_ref).toBe("ref");
    expect(bindingCovering(withBinding, root)).toBeNull();
  });

  it("switches scope and names the default server", () => {
    expect(setDefaultScope(config(), "listed").default_scope).toBe("listed");
    expect(defaultServerName(config())).toBe("agentboard.cloud");
  });
});
