/**
 * ApiClient's refresh behaviour (stage 3).
 *
 * Two properties matter here. The 401 retry must be capped at one attempt — a
 * server answering 401 to everything would otherwise spin the client through
 * the refresh endpoint until it hit the rate limit. And a per-project `.cred`
 * client must never refresh at all: that credential is not part of a refresh
 * family, so sending it to the refresh endpoint is simply wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let configDir: string;
const API = "https://api.example.test";

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-client-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
});

const nowSec = () => Math.floor(Date.now() / 1000);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function writeBundle(bundle: Record<string, unknown>) {
  const { saveTokenBundle } = await import("../../src/platform/credential-store");
  saveTokenBundle(bundle as never);
}

describe("default-route client", () => {
  it("retries a 401 exactly once after refreshing", async () => {
    await writeBundle({
      v: 1,
      access: "stale",
      access_expires_at: nowSec() + 3600,
      refresh: "r1",
    });

    const calls: string[] = [];
    // First device call 401s, the retry after the refresh succeeds.
    let deviceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith("/v1/auth/token/refresh")) {
          return jsonResponse({
            v: 1,
            access: "fresh",
            access_expires_at: nowSec() + 3600,
            refresh: "r2",
          });
        }
        deviceCalls++;
        return deviceCalls === 1 ? jsonResponse({}, 401) : jsonResponse([], 200);
      })
    );

    const { createDefaultRouteClient } = await import("../../src/api/client");
    const client = createDefaultRouteClient(API, "stale");
    await client.getDevices();

    expect(calls.filter((u) => u.endsWith("/v1/auth/token/refresh"))).toHaveLength(1);
    expect(deviceCalls).toBe(2);
  });

  // 401을 계속 주는 서버에서 무한 루프에 빠지면 rate limit에 걸린다.
  it("gives up after one retry when the 401 persists", async () => {
    await writeBundle({
      v: 1,
      access: "stale",
      access_expires_at: nowSec() + 3600,
      refresh: "r1",
    });

    let refreshCalls = 0;
    let deviceCalls = 0;
    let issued = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/auth/token/refresh")) {
          refreshCalls++;
          issued++;
          return jsonResponse({
            v: 1,
            access: `fresh-${issued}`,
            access_expires_at: nowSec() + 3600,
            refresh: `r${issued + 1}`,
          });
        }
        deviceCalls++;
        return jsonResponse({ code: "unauthorized" }, 401);
      })
    );

    const { createDefaultRouteClient, ApiError } = await import("../../src/api/client");
    const client = createDefaultRouteClient(API, "stale");

    await expect(client.getDevices()).rejects.toBeInstanceOf(ApiError);
    expect(refreshCalls).toBe(1);
    expect(deviceCalls).toBe(2);
  });

  it("refreshes pre-emptively before the request when near expiry", async () => {
    await writeBundle({
      v: 1,
      access: "old",
      access_expires_at: nowSec() + 30,
      refresh: "r1",
    });

    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/v1/auth/token/refresh")) {
          order.push("refresh");
          return jsonResponse({
            v: 1,
            access: "fresh",
            access_expires_at: nowSec() + 3600,
            refresh: "r2",
          });
        }
        order.push(`request:${(init.headers as Record<string, string>).Authorization}`);
        return jsonResponse([], 200);
      })
    );

    const { createDefaultRouteClient } = await import("../../src/api/client");
    await createDefaultRouteClient(API, "old").getDevices();

    expect(order).toEqual(["refresh", "request:Bearer fresh"]);
  });
});

describe("per-project credential client", () => {
  // .cred 는 회전 대상이 아니다. refresh 엔드포인트에 보내면 그냥 에러다.
  it("never calls the refresh endpoint", async () => {
    await writeBundle({
      v: 1,
      access: "default-access",
      access_expires_at: nowSec() + 1,
      refresh: "r1",
    });

    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse([], 200);
      })
    );

    const { createApiClient } = await import("../../src/api/client");
    await createApiClient(API, "project-cred").getDevices();

    expect(urls.some((u) => u.includes("/v1/auth/token/refresh"))).toBe(false);
  });
});
