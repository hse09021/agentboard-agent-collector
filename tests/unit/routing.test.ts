import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONFIG_VERSION,
  type Binding,
  type CollectorConfigV2,
} from "../../src/core/config-schema";
import {
  DEFAULT_ROUTE_ID,
  matchBinding,
  resolveRoute,
  routeForId,
} from "../../src/core/routing";
import { isPathPrefix, normalizePath } from "../../src/core/path-normalize";

const COMMUNITY = {
  api_base_url: "https://agentboard.cloud/api/proxy",
  app_base_url: "https://agentboard.cloud",
  device_id: "dev_community",
};

const ACME = {
  api_base_url: "https://agentboard.acme.internal/api",
  app_base_url: "https://agentboard.acme.internal",
  device_id: "dev_acme",
};

function binding(dir: string, server = ACME, ref = "acme-ref"): Binding {
  return {
    abs_dir: dir,
    real_dir: dir,
    server,
    credential_ref: ref,
    connected_at: "2026-09-06T00:00:00.000Z",
  };
}

function config(bindings: Binding[]): CollectorConfigV2 {
  return {
    version: CONFIG_VERSION,
    device_id: COMMUNITY.device_id,
    api_base_url: COMMUNITY.api_base_url,
    app_base_url: COMMUNITY.app_base_url,
    default_server: COMMUNITY,
    bindings,
    snapshot_target: "routed",
  };
}

describe("isPathPrefix", () => {
  // A bare startsWith would make /work/api swallow /work/api-secret, sending a
  // different project's telemetry to the wrong organization's server.
  it("does not let a directory swallow a sibling with a shared prefix", () => {
    expect(isPathPrefix("/work/api", "/work/api-secret")).toBe(false);
    expect(isPathPrefix("/work/api", "/work/api")).toBe(true);
    expect(isPathPrefix("/work/api", "/work/api/src")).toBe(true);
  });

  it("returns false for null on either side", () => {
    expect(isPathPrefix(null, "/x")).toBe(false);
    expect(isPathPrefix("/x", null)).toBe(false);
  });
});

describe("matchBinding", () => {
  let root: string;
  let work: string;
  let api: string;
  let apiSecret: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-route-")));
    work = path.join(root, "work");
    api = path.join(work, "api");
    apiSecret = path.join(work, "api-secret");
    fs.mkdirSync(path.join(api, "src"), { recursive: true });
    fs.mkdirSync(apiSecret, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("picks the longest matching prefix", () => {
    const bindings = [
      binding(work, COMMUNITY, "work-ref"),
      binding(api, ACME, "api-ref"),
    ];
    expect(matchBinding(bindings, path.join(api, "src"))?.credential_ref).toBe("api-ref");
    expect(matchBinding(bindings, work)?.credential_ref).toBe("work-ref");
  });

  it("does not match a sibling directory sharing a prefix", () => {
    expect(matchBinding([binding(api)], apiSecret)).toBeNull();
  });

  it("returns null when cwd is missing", () => {
    expect(matchBinding([binding(api)], undefined)).toBeNull();
    expect(matchBinding([binding(api)], null)).toBeNull();
  });

  it("matches through a symlinked binding directory", () => {
    const link = path.join(root, "link-to-api");
    try {
      fs.symlinkSync(api, link, "junction");
    } catch {
      return; // symlink creation needs privileges on some Windows setups
    }
    // Connected via the symlink, worked in the real path — and the reverse.
    const viaLink: Binding = { ...binding(api), abs_dir: link, real_dir: fs.realpathSync(link) };
    expect(matchBinding([viaLink], api)).not.toBeNull();
    expect(matchBinding([viaLink], link)).not.toBeNull();
  });
});

describe("resolveRoute", () => {
  let root: string;
  let api: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-resolve-")));
    api = path.join(root, "api");
    fs.mkdirSync(api, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("sends unconnected directories to the community server", () => {
    const route = resolveRoute({ config: config([]), cwd: api });
    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID, credentialRef: null });
    if (route.kind === "send") expect(route.server.api_base_url).toBe(COMMUNITY.api_base_url);
  });

  it("sends a connected directory to its own server", () => {
    const route = resolveRoute({ config: config([binding(api)]), cwd: api });
    expect(route).toMatchObject({ kind: "send", routeId: "acme-ref", credentialRef: "acme-ref" });
    if (route.kind === "send") expect(route.server.api_base_url).toBe(ACME.api_base_url);
  });

  it("routes to the community server when cwd is unavailable", () => {
    const route = resolveRoute({ config: config([binding(api)]), cwd: null });
    expect(route).toMatchObject({ routeId: DEFAULT_ROUTE_ID });
  });

  // The single most important privacy behaviour in this module.
  //
  // The ledger holds one cumulative total per session. If a directory is
  // connected partway through a session and the route were re-derived from cwd,
  // the organization's server would receive the whole cumulative figure —
  // including the personal work that happened before the connection.
  it("keeps a session on its original route after the directory is connected", () => {
    const afterConnect = config([binding(api)]);
    const route = resolveRoute({
      config: afterConnect,
      cwd: api,
      pinnedRouteId: DEFAULT_ROUTE_ID,
    });

    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID });
    if (route.kind === "send") expect(route.server.api_base_url).toBe(COMMUNITY.api_base_url);
  });

  it("keeps a session pinned to an organization even when cwd moves away", () => {
    const route = resolveRoute({
      config: config([binding(api)]),
      cwd: root, // outside the binding
      pinnedRouteId: "acme-ref",
    });
    expect(route).toMatchObject({ routeId: "acme-ref" });
  });

  // Silently falling back to another server would ship an organization's
  // telemetry somewhere it was never meant to go.
  it("blocks instead of rerouting when the pinned route is gone", () => {
    const route = resolveRoute({
      config: config([]),
      cwd: api,
      pinnedRouteId: "deleted-ref",
    });
    expect(route).toEqual({ kind: "blocked", reason: "route_missing" });
  });

  it("resolves the default route id to the default server", () => {
    const route = routeForId(config([]), DEFAULT_ROUTE_ID);
    expect(route).toMatchObject({ kind: "send", credentialRef: null });
  });
});

describe("normalizePath", () => {
  it("strips trailing separators", () => {
    expect(normalizePath("/a/b/")).toBe(normalizePath("/a/b"));
    expect(normalizePath("/a/b//")).toBe(normalizePath("/a/b"));
  });

  // path.resolve("/") differs by platform ("/" vs a drive root), so assert the
  // property that matters rather than a literal: whatever a root normalizes
  // to, it must still prefix-match its own children.
  it("keeps a root usable as a prefix", () => {
    const root = normalizePath("/");
    expect(root).toBeTruthy();
    expect(isPathPrefix(root, normalizePath("/anything"))).toBe(true);
  });

  it("returns null for empty input", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
    expect(normalizePath(null)).toBeNull();
  });
});
