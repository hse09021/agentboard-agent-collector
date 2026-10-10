/**
 * The `.cred` storage format (#15, stage 1) and the per-connection lock
 * (stage 2).
 *
 * The CLI (`connect`, `status`, `disconnect`) and the hooks read the same file
 * with separate code, so the two parsers are checked against each other, and
 * against the inputs that go wrong in practice: a legacy single JWT, a pair, a
 * truncated or empty file, and a read racing a write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

const REF = "98eec09f0eec6fbe";
const LEGACY = `${b64({ alg: "HS256" })}.${b64({ sub: "u1", exp: 2000000000 })}.sig`;
const ACCESS = `${b64({ alg: "HS256" })}.${b64({ sub: "u1", pair: true, exp: 1791003600 })}.sig`;
const PAIR = {
  v: 2,
  access: ACCESS,
  access_expires_at: 1791003600,
  refresh: "opaque-refresh",
  refresh_expires_at: 1798776000,
};

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** Reads the file in a loop and counts reads that are not a whole credential. */
const READER = `
const fs = require("fs");
const [file, ms] = process.argv.slice(1);
process.stdout.write("ready\\n");
const end = Date.now() + Number(ms);
let reads = 0, bad = 0;
while (Date.now() < end) {
  let text;
  try { text = fs.readFileSync(file, "utf-8").trim(); } catch { continue; }
  reads++;
  if (!text) { bad++; continue; }
  if (text.startsWith("{")) { try { if (!JSON.parse(text).refresh) bad++; } catch { bad++; } }
}
process.stdout.write(JSON.stringify({ reads, bad }));
`;

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-cred-file-"));
  vi.stubEnv("AGENTBOARD_CONFIG_DIR", configDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
});

const store = () => import("../../src/platform/credential-store");
// @ts-expect-error — plain ESM mirror without type declarations
const hook = () => import("../../plugin/hooks/lib/config.mjs");
const credPath = () => path.join(configDir, "credentials", `${REF}.cred`);

describe("parseProjectCredentialFile", () => {
  const cases: Array<[string, string]> = [
    ["a legacy JWT", LEGACY],
    ["a legacy JWT with a trailing newline", `${LEGACY}\n`],
    ["a pair", JSON.stringify(PAIR)],
    ["a pair without access_expires_at", JSON.stringify({ ...PAIR, access_expires_at: undefined })],
    ["a pair without a version", JSON.stringify({ ...PAIR, v: undefined })],
    ["a pair without a refresh token", JSON.stringify({ ...PAIR, refresh: undefined })],
    ["a pair without an access token", JSON.stringify({ ...PAIR, access: "" })],
    ["truncated JSON", JSON.stringify(PAIR).slice(0, 40)],
    ["a JSON array", "[1,2]"],
    ["an empty file", ""],
    ["whitespace", "  \n"],
  ];

  it("reads a legacy JWT as a credential with no refresh token", async () => {
    const { parseProjectCredentialFile } = await store();
    expect(parseProjectCredentialFile(`${LEGACY}\n`)).toEqual({
      v: 1,
      access: LEGACY,
      access_expires_at: 2000000000,
      refresh: null,
    });
  });

  it("reads a pair, filling the access expiry from the JWT when absent", async () => {
    const { parseProjectCredentialFile } = await store();
    expect(parseProjectCredentialFile(JSON.stringify(PAIR))).toEqual(PAIR);
    expect(
      parseProjectCredentialFile(JSON.stringify({ ...PAIR, access_expires_at: undefined }))?.access_expires_at
    ).toBe(1791003600);
  });

  // ★ 깨진 JSON을 레거시로 읽으면 반쪽짜리 파일이 Bearer로 서버에 간다.
  //   refresh 없는 묶음은 한 시간 뒤 죽고 갱신할 수도 없으므로 없는 것과 같다.
  it("reads corrupt, empty or incomplete files as no credential", async () => {
    const { parseProjectCredentialFile } = await store();
    for (const contents of [
      JSON.stringify(PAIR).slice(0, 40),
      "{}",
      "",
      "  \n",
      JSON.stringify({ ...PAIR, refresh: undefined }),
      JSON.stringify({ ...PAIR, access: "" }),
    ]) {
      expect(parseProjectCredentialFile(contents)).toBeNull();
    }
  });

  it("agrees with the hook's copy on every input", async () => {
    const ts = await store();
    const mjs = await hook();
    for (const [label, contents] of cases) {
      expect(mjs.parseProjectCredentialFile(contents), label).toEqual(ts.parseProjectCredentialFile(contents));
    }
  });

  it("serializes byte-identically in both runtimes, and a legacy credential as the bare JWT", async () => {
    const ts = await store();
    const mjs = await hook();
    const legacy = ts.parseProjectCredentialFile(LEGACY)!;
    expect(ts.serializeProjectCredential(legacy)).toBe(LEGACY);
    expect(mjs.serializeProjectCredential(legacy)).toBe(LEGACY);
    expect(mjs.serializeProjectCredential(PAIR)).toBe(ts.serializeProjectCredential(PAIR));
    expect(ts.parseProjectCredentialFile(ts.serializeProjectCredential(PAIR))).toEqual(PAIR);
  });
});

describe("saveCredential / loadProjectCredential", () => {
  it("stores a pair as JSON and a legacy credential as before, mode 0600", async () => {
    const { saveCredential, loadProjectCredential, loadCredential } = await store();

    saveCredential(REF, LEGACY);
    expect(fs.readFileSync(credPath(), "utf-8")).toBe(LEGACY);
    expect(loadCredential(REF)).toBe(LEGACY);

    saveCredential(REF, PAIR);
    expect(JSON.parse(fs.readFileSync(credPath(), "utf-8"))).toEqual(PAIR);
    expect(loadProjectCredential(REF)).toEqual(PAIR);
    // Uploads use the access token, never the refresh token.
    expect(loadCredential(REF)).toBe(ACCESS);
    expect(fs.statSync(credPath()).mode & 0o777).toBe(0o600);
  });

  it("is read by the hooks the same way", async () => {
    const { saveCredential } = await store();
    saveCredential(REF, PAIR);
    const mjs = await hook();
    expect(mjs.loadProjectCredential(REF)).toEqual(PAIR);
    expect(mjs.loadRouteCredential(REF)).toBe(ACCESS);
  });

  // ★ writeFileSync는 먼저 파일을 비운다. 그 사이에 훅이 읽으면 자격증명이 없는
  //   것으로 보고 업로드를 건너뛴다.
  it("never exposes a half-written file to a concurrent reader", async () => {
    const { saveCredential } = await store();
    const mjs = await hook();
    // A large refresh token widens the window a non-atomic write would leave.
    const big = { ...PAIR, refresh: "r".repeat(256 * 1024) };
    saveCredential(REF, LEGACY);

    const reader = spawn(process.execPath, ["-e", READER, credPath(), "600"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    reader.stdout.on("data", (c) => (out += c));
    await new Promise<void>((resolve) => reader.stdout.once("data", () => resolve()));
    const done = new Promise<void>((resolve) => reader.on("exit", () => resolve()));

    // Both writers: `connect` (CLI) and a rotating hook.
    const end = Date.now() + 400;
    for (let i = 0; Date.now() < end; i++) {
      if (i % 2) saveCredential(REF, i % 4 === 1 ? LEGACY : big);
      else mjs.saveProjectCredential(REF, i % 4 === 0 ? big : PAIR);
    }
    await done;

    const { reads, bad } = JSON.parse(out.slice(out.indexOf("{")));
    expect(reads).toBeGreaterThan(0);
    expect(bad).toBe(0);
    expect(fs.readdirSync(path.dirname(credPath())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("the hooks write atomically too, and keep the mode", async () => {
    const { saveCredential } = await store();
    saveCredential(REF, LEGACY);
    const mjs = await hook();

    mjs.saveProjectCredential(REF, PAIR);

    expect(JSON.parse(fs.readFileSync(credPath(), "utf-8"))).toEqual(PAIR);
    expect(fs.statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(credPath())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("deleting a connection removes a lock a killed hook left behind", async () => {
    const { saveCredential, deleteCredential, getCredentialLockPath } = await store();
    saveCredential(REF, PAIR);
    fs.writeFileSync(getCredentialLockPath(REF), "12345\n");

    deleteCredential(REF);

    expect(fs.existsSync(credPath())).toBe(false);
    expect(fs.existsSync(getCredentialLockPath(REF))).toBe(false);
  });
});

describe("per-connection lock", () => {
  // The CLI and the hooks must name the same file, or they would not exclude
  // each other.
  it("lives at credentials/<ref>.lock in both runtimes", async () => {
    const { getCredentialLockPath } = await store();
    const mjs = await hook();
    expect(getCredentialLockPath(REF)).toBe(path.join(configDir, "credentials", `${REF}.lock`));
    expect(mjs.projectCredentialLockPath(REF)).toBe(getCredentialLockPath(REF));
    expect(mjs.projectCredentialLockPath("../escape")).toBeNull();
    expect(() => getCredentialLockPath("../escape")).toThrow();
  });

  it("does not make different connections, or the default route, wait on each other", async () => {
    const lock = await import("../../src/platform/token-lock");
    const a = path.join(configDir, "credentials", "aaaa.lock");
    const b = path.join(configDir, "credentials", "bbbb.lock");

    expect(await lock.acquireFileLock(a)).toBe(true);
    expect(await lock.acquireFileLock(b, 100)).toBe(true);
    expect(await lock.acquireTokenLock(100)).toBe(true);
    expect(await lock.acquireFileLock(a, 100)).toBe(false);

    lock.releaseFileLock(a);
    lock.releaseFileLock(b);
    lock.releaseTokenLock();
  });

  it("takes over a stale lock and releases even when the work throws", async () => {
    const lock = await import("../../src/platform/token-lock");
    const a = path.join(configDir, "credentials", "aaaa.lock");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.writeFileSync(a, "99999\n");
    const old = (Date.now() - lock.LOCK_STALE_MS - 1000) / 1000;
    fs.utimesSync(a, old, old);

    await expect(
      lock.withFileLock(
        a,
        async () => {
          throw new Error("boom");
        },
        () => "busy"
      )
    ).rejects.toThrow("boom");
    expect(fs.existsSync(a)).toBe(false);
  });
});
