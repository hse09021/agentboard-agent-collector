/**
 * Which Claude plan the hooks report, and where they found it.
 *
 * Mirror of the plan half of plugin/hooks/lib/usage-limit-collector.mjs — see
 * that file for why `.claude.json` is read before the credentials and how the
 * Keychain item is named. The hooks are ESM and this CLI compiles to CommonJS,
 * so the logic exists in both forms; tests/unit/claude-plan.test.ts runs the
 * two against the same fixtures. Keep them in sync.
 *
 * `doctor` uses this copy so a stale plan is visible without waiting for a
 * snapshot to reach the dashboard.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ClaudePlanSource = "claude_json" | "credentials_file" | "keychain";

export interface ClaudePlanDetection {
  planName: string;
  source: ClaudePlanSource;
}

export interface ClaudePlanOptions {
  env?: NodeJS.ProcessEnv;
  profilePath?: string;
  credentialsPath?: string;
  keychainReader?: (service: string) => string;
}

function normalizeClaudePlanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase().replace(/[_-]+/g, " ").trim();
  if (!normalized) return undefined;

  if (/\bmax\b/.test(normalized) && /\b20x?\b/.test(normalized)) return "max20x";
  if (/\bmax\b/.test(normalized) && /\b5x?\b/.test(normalized)) return "max5x";
  if (/\bpro\b/.test(normalized)) return "pro";
  if (/\bfree\b/.test(normalized)) return "free";
  if (/\bteam\b/.test(normalized)) return "team";
  if (/\bbusiness\b/.test(normalized)) return "business";
  if (/\benterprise\b/.test(normalized)) return "enterprise";

  return undefined;
}

function planFromCredentialsJson(raw: string): string | undefined {
  const account = JSON.parse(raw)?.claudeAiOauth;
  for (const candidate of [account?.subscriptionType, account?.rateLimitTier]) {
    const planName = normalizeClaudePlanName(candidate);
    if (planName) return planName;
  }
  return undefined;
}

const PROFILE_PLAN_BY_ORGANIZATION_TYPE = new Map<unknown, string>([
  ["claude_pro", "pro"],
  ["claude_team", "team"],
  ["claude_enterprise", "enterprise"],
]);
const PROFILE_MAX_PLAN_BY_RATE_LIMIT_TIER = new Map<unknown, string>([
  ["default_claude_max_5x", "max5x"],
  ["default_claude_max_20x", "max20x"],
]);

/** Reads only the two plan fields; `oauthAccount` also holds email and names. */
function planFromProfileJson(raw: string): string | undefined {
  const account = JSON.parse(raw)?.oauthAccount;
  const organizationType: unknown = account?.organizationType;
  const rateLimitTier: unknown = account?.organizationRateLimitTier;

  if (organizationType === "claude_max") {
    return PROFILE_MAX_PLAN_BY_RATE_LIMIT_TIER.get(rateLimitTier);
  }
  return PROFILE_PLAN_BY_ORGANIZATION_TYPE.get(organizationType);
}

/** `join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json")` — the home dir itself, not ~/.claude/. */
export function claudeProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || os.homedir(), ".claude.json");
}

/** CLAUDE_SECURESTORAGE_CONFIG_DIR whenever defined (empty meaning ~/.claude), else the config dir. */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir =
    secureDir !== undefined
      ? secureDir || path.join(os.homedir(), ".claude")
      : env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Claude Code's own rule, copied as is: the raw env value is hashed. */
export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const hashedDir = secureDir !== undefined ? secureDir : env.CLAUDE_CONFIG_DIR;
  if (!hashedDir) return CLAUDE_KEYCHAIN_SERVICE;

  const suffix = createHash("sha256").update(hashedDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

function readClaudeKeychainCredentials(
  service: string,
  execImpl: (service: string) => string = (name) =>
    execFileSync("security", ["find-generic-password", "-s", name, "-w"], {
      encoding: "utf-8",
      // doctor runs in a terminal: keep `security`'s "item not found" off it.
      stdio: ["ignore", "pipe", "ignore"],
    })
): string {
  try {
    return execImpl(service) ?? "";
  } catch {
    return "";
  }
}

/**
 * `.claude.json` first, then the credentials file, then the macOS Keychain.
 * Returns only the plan name and its source — never tokens or account fields.
 */
export function detectClaudeSubscriptionPlan(
  opts: ClaudePlanOptions = {}
): ClaudePlanDetection | undefined {
  const env = opts.env ?? process.env;

  try {
    const raw = fs.readFileSync(opts.profilePath ?? claudeProfilePath(env), "utf-8");
    const planName = planFromProfileJson(raw);
    if (planName) return { planName, source: "claude_json" };
  } catch {
    // Missing or half-written: fall back to the credentials.
  }

  try {
    const raw = fs.readFileSync(opts.credentialsPath ?? claudeCredentialsPath(env), "utf-8");
    const planName = planFromCredentialsJson(raw);
    if (planName) return { planName, source: "credentials_file" };
  } catch {
    // Best-effort only.
  }

  if (process.platform === "darwin" || opts.keychainReader) {
    try {
      const raw = readClaudeKeychainCredentials(claudeKeychainService(env), opts.keychainReader);
      if (raw) {
        const planName = planFromCredentialsJson(raw);
        if (planName) return { planName, source: "keychain" };
      }
    } catch {
      // Best-effort only.
    }
  }

  return undefined;
}

/**
 * The doctor line. Names the source because that is the whole diagnosis: the
 * credentials are written at sign-in only, so a plan read from them can be one
 * the user has since changed on claude.ai.
 */
export function describeClaudePlan(
  detection: ClaudePlanDetection | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!detection) return "Not detected (no claude.ai plan in .claude.json or credentials)";

  const { planName, source } = detection;
  switch (source) {
    case "claude_json":
      return `${planName} (from ${claudeProfilePath(env)})`;
    case "credentials_file":
      return `${planName} (from ${claudeCredentialsPath(env)}, as of last sign-in)`;
    case "keychain":
      return `${planName} (from Keychain "${claudeKeychainService(env)}", as of last sign-in)`;
  }
}
