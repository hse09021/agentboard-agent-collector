/**
 * Storage format for ~/.agentboard/.token (stage 1).
 *
 * The file is read by two independent implementations (the CLI here and the
 * hook's config.mjs), and it must keep reading the pre-0.10 single-JWT file
 * that every existing install still has on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-token-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function store() {
  return import("../../src/platform/credential-store");
}

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

const tokenPath = () => path.join(configDir, ".token");

describe("parseTokenFile", () => {
  it("reads a legacy single JWT and promotes it to a bundle", async () => {
    const { parseTokenFile } = await store();
    const jwt = makeJwt({ exp: 1_760_003_600 });

    const bundle = parseTokenFile(jwt);

    expect(bundle).toEqual({
      v: 1,
      access: jwt,
      access_expires_at: 1_760_003_600,
      refresh: null,
    });
  });

  it("reads the JSON bundle format", async () => {
    const { parseTokenFile } = await store();

    const bundle = parseTokenFile(
      JSON.stringify({
        v: 1,
        access: "acc",
        access_expires_at: 100,
        refresh: "ref",
        refresh_expires_at: 200,
      })
    );

    expect(bundle).toEqual({
      v: 1,
      access: "acc",
      access_expires_at: 100,
      refresh: "ref",
      refresh_expires_at: 200,
    });
  });

  it("returns null for an empty file", async () => {
    const { parseTokenFile } = await store();
    expect(parseTokenFile("")).toBeNull();
    expect(parseTokenFile("   \n ")).toBeNull();
  });

  // 반쯤 쓰인 파일을 레거시 토큰으로 착각해 저장하면, 서버에 쓰레기를 Bearer 로
  // 보내게 된다. `{` 로 시작했는데 JSON 이 아니면 자격증명이 아니다.
  it("returns null for a truncated bundle instead of treating it as legacy", async () => {
    const { parseTokenFile } = await store();
    expect(parseTokenFile('{"v":1,"access":"eyJ')).toBeNull();
  });

  it("returns null for a bundle with no access token", async () => {
    const { parseTokenFile } = await store();
    expect(parseTokenFile(JSON.stringify({ v: 1, refresh: "r" }))).toBeNull();
  });

  it("treats an empty refresh as absent", async () => {
    const { parseTokenFile } = await store();
    expect(parseTokenFile(JSON.stringify({ access: "a", refresh: "" }))?.refresh).toBeNull();
  });
});

describe("saveTokenBundle / loadTokenBundle", () => {
  it("round-trips a bundle", async () => {
    const { saveTokenBundle, loadTokenBundle } = await store();
    const bundle = {
      v: 1,
      access: "acc",
      access_expires_at: 100,
      refresh: "ref",
      refresh_expires_at: 200,
    };

    saveTokenBundle(bundle);

    expect(loadTokenBundle()).toEqual(bundle);
  });

  it("writes the file 0600", async () => {
    const { saveTokenBundle } = await store();
    saveTokenBundle({ v: 1, access: "acc", refresh: "ref" });

    // Windows does not model POSIX permission bits.
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    }
  });

  // 훅이 여러 개 도는 중에 잘린 파일이 읽히면 "로그아웃됨"으로 보여 업로드가
  // 조용히 사라진다. 임시 파일 + rename 이라 리더는 항상 온전한 파일을 본다.
  it("leaves no temp file behind and never exposes a partial file", async () => {
    const { saveTokenBundle, loadTokenBundle } = await store();
    saveTokenBundle({ v: 1, access: "first", refresh: "r1" });
    saveTokenBundle({ v: 1, access: "second", refresh: "r2" });

    expect(loadTokenBundle()?.access).toBe("second");
    expect(fs.readdirSync(configDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("keeps 0600 when overwriting an existing token file", async () => {
    const { saveTokenBundle } = await store();
    saveTokenBundle({ v: 1, access: "first", refresh: "r1" });
    if (process.platform !== "win32") fs.chmodSync(tokenPath(), 0o644);

    saveTokenBundle({ v: 1, access: "second", refresh: "r2" });

    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null when nothing is stored", async () => {
    const { loadTokenBundle, loadToken, hasToken } = await store();
    expect(loadTokenBundle()).toBeNull();
    expect(loadToken()).toBeNull();
    expect(hasToken()).toBe(false);
  });
});

describe("loadToken compatibility", () => {
  // 기존 호출부(status/doctor/install-hooks)는 문자열 하나만 다룬다. 저장 형식이
  // 바뀌어도 그 계약은 그대로여야 한다.
  it("returns the access token for both storage formats", async () => {
    const { loadToken, saveTokenBundle } = await store();
    const jwt = makeJwt({ exp: 1_760_003_600 });

    fs.writeFileSync(tokenPath(), jwt);
    expect(loadToken()).toBe(jwt);

    saveTokenBundle({ v: 1, access: "acc", refresh: "ref" });
    expect(loadToken()).toBe("acc");
  });

  it("saveToken accepts a bare access token and stores it as a bundle", async () => {
    const { saveToken, loadTokenBundle } = await store();
    const jwt = makeJwt({ exp: 1_760_003_600 });

    saveToken(jwt);

    expect(loadTokenBundle()).toEqual({
      v: 1,
      access: jwt,
      access_expires_at: 1_760_003_600,
      refresh: null,
    });
  });
});

describe("deleteToken", () => {
  it("removes the token and any leaked refresh lock", async () => {
    const { saveTokenBundle, deleteToken, hasToken } = await store();
    saveTokenBundle({ v: 1, access: "acc", refresh: "ref" });
    fs.writeFileSync(path.join(configDir, ".token.lock"), "999");

    deleteToken();

    expect(hasToken()).toBe(false);
    expect(fs.existsSync(path.join(configDir, ".token.lock"))).toBe(false);
  });
});
