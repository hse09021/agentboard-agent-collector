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

  // The single most important privacy behaviour in this module, now in both
  // directions.
  //
  // The ledger holds one cumulative total per session. Moving a community
  // session to the organization when its directory is connected would hand
  // the organization the personal work done before the connection; keeping it
  // on the community server ships the organization's work there for as long
  // as the session lives (#17). So the session is handed off at
  // `connected_at`: the route says where each side goes, and the upload
  // splits the tokens at that instant (see daily-split's splitHandoffDelta).
  it("hands a community-pinned session off at the moment its directory was connected", () => {
    const afterConnect = config([binding(api)]);
    const route = resolveRoute({
      config: afterConnect,
      cwd: api,
      pinnedRouteId: DEFAULT_ROUTE_ID,
    });

    expect(route).toMatchObject({
      kind: "handoff",
      splitAt: "2026-09-06T00:00:00.000Z",
      from: { kind: "send", routeId: DEFAULT_ROUTE_ID, credentialRef: null },
      to: { kind: "send", routeId: "acme-ref", credentialRef: "acme-ref" },
    });
    if (route.kind !== "handoff") return;
    // Tokens from before the connection only ever go to the community server.
    expect(route.from.server.api_base_url).toBe(COMMUNITY.api_base_url);
    expect(route.to.server.api_base_url).toBe(ACME.api_base_url);
  });

  it("keeps a community-pinned session on the community server outside connected directories", () => {
    const route = resolveRoute({
      config: config([binding(api)]),
      cwd: root,
      pinnedRouteId: DEFAULT_ROUTE_ID,
    });
    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID });
  });

  // Without the instant there is nothing to split at; the session stays where
  // it is rather than handing pre-connect work to the organization.
  it("does not hand off when the binding has no usable connected_at", () => {
    const broken = { ...binding(api), connected_at: "not a date" };
    const route = resolveRoute({
      config: config([broken]),
      cwd: api,
      pinnedRouteId: DEFAULT_ROUTE_ID,
    });
    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID });
  });

  // An unpinned session has no community history to protect, and splitting it
  // at a reset `connected_at` (a reconnect) would send organization work that
  // never uploaded under the old connection to the community server.
  it("routes an unpinned session in a connected directory by cwd alone", () => {
    const route = resolveRoute({ config: config([binding(api)]), cwd: api, pinnedRouteId: null });
    expect(route).toMatchObject({ kind: "send", routeId: "acme-ref" });
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

  // The hook runtime carries its own copy (plugin/hooks/lib/routing.mjs). If
  // the two ever disagree, the CLI shows one destination and the hook uses
  // another.
  it("agrees with the hook runtime's copy on every branch", async () => {
    const hook = await import("../../plugin/hooks/lib/routing.mjs");
    const other = path.join(root, "other");
    const cases = [
      { bindings: [], cwd: api, pinnedRouteId: null },
      { bindings: [binding(api)], cwd: api, pinnedRouteId: null },
      { bindings: [binding(api)], cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID },
      { bindings: [binding(api)], cwd: other, pinnedRouteId: DEFAULT_ROUTE_ID },
      { bindings: [binding(api)], cwd: other, pinnedRouteId: "acme-ref" },
      { bindings: [binding(api)], cwd: api, pinnedRouteId: "acme-ref" },
      { bindings: [], cwd: api, pinnedRouteId: "deleted-ref" },
      { bindings: [{ ...binding(api), connected_at: "" }], cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID },
      { bindings: [binding(api)], cwd: null, pinnedRouteId: DEFAULT_ROUTE_ID },
    ];
    for (const { bindings, ...rest } of cases) {
      const input = { config: config(bindings), ...rest };
      expect(hook.resolveRoute(input), JSON.stringify(rest)).toEqual(resolveRoute(input));
    }
  });
});

// #23: "listed" scope sends only tracked directories to the community server,
// and only what was used after each was added. "all", the default, is the
// behaviour above.
describe("resolveRoute in listed scope", () => {
  let root: string;
  let api: string;
  let side: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-scope-")));
    api = path.join(root, "api");
    side = path.join(root, "side");
    fs.mkdirSync(api, { recursive: true });
    fs.mkdirSync(path.join(side, "src"), { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const ADDED = "2026-11-24T00:00:00.000Z";
  const listed = (bindings: Binding[], tracked: string[]): CollectorConfigV2 => ({
    ...config(bindings),
    default_scope: "listed",
    tracked_dirs: tracked.map((dir) => ({ abs_dir: dir, real_dir: dir, added_at: ADDED })),
  });

  it("sends a tracked directory, and below it, only from when it was added", () => {
    const route = resolveRoute({ config: listed([], [side]), cwd: path.join(side, "src") });
    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID, since: ADDED });
  });

  it("sends nothing for an untracked directory", () => {
    expect(resolveRoute({ config: listed([], [side]), cwd: root })).toEqual({ kind: "skip", reason: "not_tracked" });
  });

  it("sends nothing when the cwd is unknown", () => {
    expect(resolveRoute({ config: listed([], [side]), cwd: null })).toMatchObject({ kind: "skip" });
  });

  // Untracking must stop a session that was already uploading.
  it("re-checks a community-pinned session against the list", () => {
    const route = resolveRoute({ config: listed([], []), cwd: side, pinnedRouteId: DEFAULT_ROUTE_ID });
    expect(route).toMatchObject({ kind: "skip" });
  });

  it("leaves connected directories and organization pins alone", () => {
    const cfg = listed([binding(api)], []);
    expect(resolveRoute({ config: cfg, cwd: api })).toMatchObject({ kind: "send", routeId: "acme-ref" });
    expect(resolveRoute({ config: cfg, cwd: root, pinnedRouteId: "acme-ref" })).toMatchObject({
      kind: "send",
      routeId: "acme-ref",
    });
  });

  it("hands off with no community side when the connected directory is not tracked", () => {
    const route = resolveRoute({ config: listed([binding(api)], []), cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID });
    expect(route).toMatchObject({ kind: "handoff", from: null, to: { routeId: "acme-ref" } });
  });

  it("hands off the tracked part of the pre-connect side when it is tracked", () => {
    const route = resolveRoute({ config: listed([binding(api)], [api]), cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID });
    expect(route).toMatchObject({ kind: "handoff", from: { routeId: DEFAULT_ROUTE_ID, since: ADDED } });
  });

  it("ignores the list in all scope", () => {
    const route = resolveRoute({ config: { ...listed([], []), default_scope: "all" }, cwd: root });
    expect(route).toMatchObject({ kind: "send", routeId: DEFAULT_ROUTE_ID });
    if (route.kind === "send") expect(route.since).toBeUndefined();
  });

  it("does not track an entry whose added_at is unusable", () => {
    const cfg = listed([], []);
    cfg.tracked_dirs = [{ abs_dir: side, real_dir: side, added_at: "soon" }];
    expect(resolveRoute({ config: cfg, cwd: side })).toMatchObject({ kind: "skip" });
  });

  it("agrees with the hook runtime's copy", async () => {
    const hook = await import("../../plugin/hooks/lib/routing.mjs");
    const cases = [
      { cfg: listed([], [side]), cwd: side, pinnedRouteId: null },
      { cfg: listed([], [side]), cwd: root, pinnedRouteId: null },
      { cfg: listed([], [side]), cwd: null, pinnedRouteId: DEFAULT_ROUTE_ID },
      { cfg: listed([], []), cwd: side, pinnedRouteId: DEFAULT_ROUTE_ID },
      { cfg: listed([binding(api)], []), cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID },
      { cfg: listed([binding(api)], [api]), cwd: api, pinnedRouteId: DEFAULT_ROUTE_ID },
      { cfg: listed([binding(api)], []), cwd: root, pinnedRouteId: "acme-ref" },
    ];
    for (const { cfg, ...rest } of cases) {
      const input = { config: cfg, ...rest };
      expect(hook.resolveRoute(input), JSON.stringify(rest)).toEqual(resolveRoute(input));
    }
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
