/**
 * src/core/claude-plan.ts (what `doctor` shows) against
 * plugin/hooks/lib/usage-limit-collector.mjs (what the hooks upload).
 *
 * The two are separate copies of the same rules, so they are run against the
 * same fixtures: a doctor line that disagreed with the upload would send the
 * user looking in the wrong place. The behaviour itself is covered in
 * tests/unit/usage-limit-collector.test.mjs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeCredentialsPath,
  claudeKeychainService,
  claudeProfilePath,
  describeClaudePlan,
  detectClaudeSubscriptionPlan,
  type ClaudePlanOptions,
} from "../../src/core/claude-plan";
// @ts-expect-error — plain ESM mirror without type declarations
import * as hook from "../../plugin/hooks/lib/usage-limit-collector.mjs";

const credentials = (subscriptionType: string, rateLimitTier?: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-secret", subscriptionType, rateLimitTier } });

const profile = (oauthAccount: Record<string, unknown>) =>
  JSON.stringify({
    oauthAccount: {
      emailAddress: "someone@example.com",
      displayName: "Some One",
      organizationName: "Secret Org Inc",
      ...oauthAccount,
    },
  });

let dir: string;
let secureDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-claude-plan-"));
  secureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-claude-secure-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(secureDir, { recursive: true, force: true });
});

interface Fixture {
  profile?: string;
  credentials?: string;
  keychain?: string;
  secure?: boolean;
}

const FIXTURES: Array<[string, Fixture]> = [
  ["pro in .claude.json over stale Max credentials", { profile: profile({ organizationType: "claude_pro" }), credentials: credentials("max", "default_claude_max_5x") }],
  ["max 5x", { profile: profile({ organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x" }) }],
  ["max 20x", { profile: profile({ organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" }) }],
  ["team", { profile: profile({ organizationType: "claude_team" }) }],
  ["enterprise", { profile: profile({ organizationType: "claude_enterprise" }) }],
  ["max with an unknown tier", { profile: profile({ organizationType: "claude_max", organizationRateLimitTier: "x" }), credentials: credentials("pro") }],
  ["claude_free", { profile: profile({ organizationType: "claude_free" }), keychain: credentials("max", "default_claude_max_20x") }],
  ["a prototype key", { profile: profile({ organizationType: "constructor" }) }],
  ["a half-written .claude.json", { profile: '{"oauthAccount":', credentials: credentials("team") }],
  ["credentials file only", { credentials: credentials("max", "claude_ai_max_20x") }],
  ["Keychain only", { keychain: credentials("enterprise") }],
  ["secure-storage dir", { credentials: credentials("pro"), secure: true }],
  ["secure-storage Keychain", { keychain: credentials("max", "default_claude_max_5x"), secure: true }],
  ["nothing at all", {}],
];

/** Writes the fixture under `dir` and returns options both copies can take. */
function setUp(fixture: Fixture): { opts: ClaudePlanOptions; keychainCalls: string[] } {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: dir };
  if (fixture.secure) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secureDir;
  if (fixture.profile !== undefined) fs.writeFileSync(path.join(dir, ".claude.json"), fixture.profile);
  if (fixture.credentials !== undefined) {
    fs.writeFileSync(path.join(fixture.secure ? secureDir : dir, ".credentials.json"), fixture.credentials);
  }
  const keychainCalls: string[] = [];
  return {
    opts: {
      env,
      keychainReader: (service: string) => {
        keychainCalls.push(service);
        return fixture.keychain ?? "";
      },
    },
    keychainCalls,
  };
}

describe("claude-plan mirrors the hook's reader", () => {
  it.each(FIXTURES)("agrees on %s", (_label, fixture) => {
    const cli = setUp(fixture);
    const fromCli = detectClaudeSubscriptionPlan(cli.opts);
    const fromHook = hook.detectClaudeSubscriptionPlan(cli.opts);

    expect(fromCli).toEqual(fromHook);
    if (fromHook !== undefined) expect(Object.keys(fromHook).sort()).toEqual(["planName", "source"]);
  });

  it("asks the Keychain for the same item", () => {
    const cli = setUp({ secure: true });
    detectClaudeSubscriptionPlan(cli.opts);
    const fromHook = setUp({ secure: true });
    hook.detectClaudeSubscriptionPlan(fromHook.opts);

    expect(cli.keychainCalls).toEqual(fromHook.keychainCalls);
    expect(cli.keychainCalls).toEqual([claudeKeychainService(cli.opts.env)]);
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["no override", {}],
    ["CLAUDE_CONFIG_DIR", { CLAUDE_CONFIG_DIR: "/tmp/claude-alt" }],
    ["a padded CLAUDE_CONFIG_DIR", { CLAUDE_CONFIG_DIR: " /tmp/claude-alt " }],
    ["both", { CLAUDE_CONFIG_DIR: "/tmp/claude-alt", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/secure-alt" }],
    ["an empty secure-storage dir", { CLAUDE_CONFIG_DIR: "/tmp/claude-alt", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }],
    ["a decomposed accent", { CLAUDE_CONFIG_DIR: "/Users/me/café" }],
  ])("resolves the same locations for %s", (_label, env) => {
    expect(claudeProfilePath(env)).toBe(hook.claudeProfilePath(env));
    expect(claudeCredentialsPath(env)).toBe(hook.claudeCredentialsPath(env));
    expect(claudeKeychainService(env)).toBe(hook.claudeKeychainService(env));
  });
});

describe("describeClaudePlan", () => {
  const env = { CLAUDE_CONFIG_DIR: "/tmp/claude-alt" };

  it("names the file a .claude.json plan came from", () => {
    expect(describeClaudePlan({ planName: "pro", source: "claude_json" }, env)).toBe(
      `pro (from ${path.join("/tmp/claude-alt", ".claude.json")})`
    );
  });

  // A plan from the credentials is the one that can be stale, so it says so.
  it("flags a credentials plan as dating from the last sign-in", () => {
    expect(describeClaudePlan({ planName: "max5x", source: "credentials_file" }, env)).toBe(
      `max5x (from ${path.join("/tmp/claude-alt", ".credentials.json")}, as of last sign-in)`
    );
    expect(describeClaudePlan({ planName: "max5x", source: "keychain" }, env)).toBe(
      'max5x (from Keychain "Claude Code-credentials-04923786", as of last sign-in)'
    );
  });

  it("reports a missing plan without failing", () => {
    expect(describeClaudePlan(undefined, env)).toMatch(/^Not detected/);
  });

  it("never prints account fields from .claude.json", () => {
    const { opts } = setUp({ profile: profile({ organizationType: "claude_pro" }) });
    const line = describeClaudePlan(detectClaudeSubscriptionPlan(opts), opts.env);

    expect(line).toMatch(/^pro \(from /);
    for (const secret of ["someone@example.com", "Some One", "Secret Org Inc"]) {
      expect(line).not.toContain(secret);
    }
  });
});
