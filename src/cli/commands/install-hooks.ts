import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { loadConfig } from "../../core/config";
import { loadToken } from "../../platform/credential-store";

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Absolute path to plugin/hooks/ relative to the installed package root.
 * Compiled file lives at: dist/cli/commands/install-hooks.js
 * Package root is 3 levels up.
 */
function getHooksDir(): string {
  return path.resolve(__dirname, "../../../plugin/hooks");
}

const HOME = os.homedir();

function getClaudeSettingsPath(): string {
  return path.join(HOME, ".claude", "settings.json");
}

function getCodexConfigPath(): string {
  return path.join(HOME, ".codex", "config.toml");
}

// Config files that older collector versions registered a SessionEnd hook in.
// Only ever read to clean up, never written to on install.
const LEGACY_HOOK_SETTINGS_PATHS = [
  path.join(HOME, ".gemini", "settings.json"),
  path.join(HOME, ".antigravity", "settings.json"),
];

// ─── CLI detection ────────────────────────────────────────────────────────────

function isBinaryInPath(bin: string): boolean {
  const cmd = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isClaudeInstalled(): boolean {
  return isBinaryInPath("claude");
}

function isCodexInstalled(): boolean {
  return isBinaryInPath("codex");
}

function getHookNodePath(nodePath: string): string {
  if (process.platform !== "win32") return nodePath;
  if (path.basename(nodePath).toLowerCase() === "nodew.exe") return nodePath;

  const nodewPath = path.join(path.dirname(nodePath), "nodew.exe");
  return fs.existsSync(nodewPath) ? nodewPath : nodePath;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
}

// ─── Generic JSON SessionEnd hook registration ────────────────────────────────

type HookResult = "added" | "already-registered" | "skipped";

function registerJsonSessionEndHook(
  settingsPath: string,
  hookEntry: Record<string, unknown>
): HookResult {
  const settings = readJson(settingsPath);

  if (typeof settings.hooks !== "object" || settings.hooks === null) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks.SessionEnd)) {
    hooks.SessionEnd = [];
  }
  const sessionEndArray = hooks.SessionEnd as Array<Record<string, unknown>>;

  for (const group of sessionEndArray) {
    if (!Array.isArray(group.hooks)) continue;
    for (const h of group.hooks as Array<Record<string, unknown>>) {
      const commandMatch =
        typeof h.command === "string" &&
        (h.command.includes("agentboard") ||
          h.command.includes("session-end.mjs"));
      const nameMatch =
        typeof h.name === "string" && h.name.includes("agentboard");
      if (commandMatch || nameMatch) {
        if (typeof group.matcher !== "string") {
          group.matcher = "";
          try {
            writeJson(settingsPath, settings);
          } catch {
            /* best-effort upgrade */
          }
        }
        return "already-registered";
      }
    }
  }

  sessionEndArray.push({ matcher: "", hooks: [hookEntry] });

  try {
    writeJson(settingsPath, settings);
    return "added";
  } catch {
    return "skipped";
  }
}

function unregisterJsonSessionEndHook(
  settingsPath: string
): "removed" | "not-found" {
  if (!fs.existsSync(settingsPath)) return "not-found";

  const settings = readJson(settingsPath);
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks.SessionEnd)) return "not-found";

  const before = (hooks.SessionEnd as unknown[]).length;
  hooks.SessionEnd = (
    hooks.SessionEnd as Array<Record<string, unknown>>
  )
    .map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      group.hooks = (
        group.hooks as Array<Record<string, unknown>>
      ).filter((h) => {
        const commandMatch =
          typeof h.command === "string" &&
          (h.command.includes("agentboard") ||
            h.command.includes("session-end.mjs"));
        const nameMatch =
          typeof h.name === "string" && h.name.includes("agentboard");
        return !(commandMatch || nameMatch);
      });
      return group;
    })
    .filter(
      (group) =>
        !Array.isArray(group.hooks) ||
        (group.hooks as unknown[]).length > 0
    );

  if ((hooks.SessionEnd as unknown[]).length === before) return "not-found";

  try {
    writeJson(settingsPath, settings);
    return "removed";
  } catch {
    return "not-found";
  }
}

// ─── Claude Code hook ─────────────────────────────────────────────────────────

function registerClaudeHook(nodeExe: string, scriptPath: string): HookResult {
  return registerJsonSessionEndHook(getClaudeSettingsPath(), {
    type: "command",
    command: nodeExe,
    args: [scriptPath],
    name: "agentboard-session-end",
    timeout: 10,
  });
}

function unregisterClaudeHook() {
  return unregisterJsonSessionEndHook(getClaudeSettingsPath());
}

// ─── Codex CLI hook registration ─────────────────────────────────────────────

const CODEX_NOTIFY_COMMENT = "# agentboard-notify";

function buildCodexNotifyLine(
  nodePath: string,
  notifyScript: string
): string {
  return `notify = [${JSON.stringify(nodePath)}, ${JSON.stringify(notifyScript)}] ${CODEX_NOTIFY_COMMENT}`;
}

function registerCodexHook(
  nodePath: string,
  notifyScript: string
): HookResult {
  const configPath = getCodexConfigPath();
  let existing = "";
  if (fs.existsSync(configPath)) {
    try {
      existing = fs.readFileSync(configPath, "utf-8");
    } catch {
      return "skipped";
    }
  }

  if (existing.includes(CODEX_NOTIFY_COMMENT)) {
    return "already-registered";
  }

  const cleaned = existing
    .split("\n")
    .filter((l) => !/^\s*notify\s*=/.test(l))
    .join("\n");
  const newLine = buildCodexNotifyLine(nodePath, notifyScript);

  const lines = cleaned.split("\n");
  const firstSectionIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  let updated: string;
  if (firstSectionIdx === -1) {
    updated =
      cleaned.trimEnd() + (cleaned.trim() ? "\n" : "") + newLine + "\n";
  } else {
    lines.splice(firstSectionIdx, 0, newLine, "");
    updated = lines.join("\n");
    if (!updated.endsWith("\n")) updated += "\n";
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, updated, { mode: 0o600 });
    return "added";
  } catch {
    return "skipped";
  }
}

function unregisterCodexHook(): "removed" | "not-found" {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return "not-found";

  let existing: string;
  try {
    existing = fs.readFileSync(configPath, "utf-8");
  } catch {
    return "not-found";
  }

  if (!existing.includes(CODEX_NOTIFY_COMMENT)) return "not-found";

  const updated = existing
    .split("\n")
    .filter((l) => !l.includes(CODEX_NOTIFY_COMMENT))
    .join("\n");

  try {
    fs.writeFileSync(configPath, updated, { mode: 0o600 });
    return "removed";
  } catch {
    return "not-found";
  }
}

// ─── install-hooks command ─────────────────────────────────────────────────────

export async function installHooksCommand(options: {
  force?: boolean;
}): Promise<void> {
  const config = loadConfig();
  const token = loadToken();

  if (!config.device_id || !token) {
    console.error(
      "✖  Not logged in. Run `agentboard login` first, then re-run `agentboard install-hooks`."
    );
    process.exit(1);
  }

  const hooksDir = getHooksDir();
  if (!fs.existsSync(hooksDir)) {
    console.error(
      `✖  Hook scripts not found at: ${hooksDir}\n` +
        `   Ensure the package was installed correctly (not just cloned).`
    );
    process.exit(1);
  }

  const nodePath = getHookNodePath(process.execPath);
  const sessionEndScript = path.join(hooksDir, "session-end.mjs");
  const codexNotifyScript = path.join(hooksDir, "codex-notify.mjs");

  console.log("Installing agentboard session hooks...\n");

  // ── Claude Code ──────────────────────────────────────────────────────────
  if (!isClaudeInstalled()) {
    console.log(`   Claude Code   not installed — skipping`);
  } else {
    const result = options.force
      ? (unregisterClaudeHook(), registerClaudeHook(nodePath, sessionEndScript))
      : registerClaudeHook(nodePath, sessionEndScript);
    const claudePath = getClaudeSettingsPath();
    if (result === "added") {
      console.log(`✔  Claude Code   → ${claudePath}`);
    } else if (result === "already-registered") {
      console.log(`   Claude Code   already registered — skipping`);
    } else {
      console.warn(`⚠  Claude Code   → could not write ${claudePath}`);
    }
  }

  // ── Codex CLI ────────────────────────────────────────────────────────────
  if (!isCodexInstalled()) {
    console.log(`   Codex CLI     not installed — skipping`);
  } else {
    const result = options.force
      ? (unregisterCodexHook(), registerCodexHook(nodePath, codexNotifyScript))
      : registerCodexHook(nodePath, codexNotifyScript);
    const codexPath = getCodexConfigPath();
    if (result === "added") {
      console.log(`✔  Codex CLI     → ${codexPath}`);
    } else if (result === "already-registered") {
      console.log(`   Codex CLI     already registered — skipping`);
    } else {
      console.warn(`⚠  Codex CLI     → could not write ${codexPath}`);
    }
  }

  console.log(
    "\nDone. Sessions will be reported automatically after each AI session ends.\n" +
      "Run `agentboard uninstall-hooks` to remove the hooks."
  );
}

// ─── uninstall-hooks command ───────────────────────────────────────────────────

export async function uninstallHooksCommand(): Promise<void> {
  console.log("Removing agentboard session hooks...\n");

  const claudeResult = unregisterClaudeHook();
  console.log(
    claudeResult === "removed"
      ? `✔  Claude Code   hook removed`
      : `   Claude Code   hook not found — skipping`
  );

  const codexResult = unregisterCodexHook();
  console.log(
    codexResult === "removed"
      ? `✔  Codex CLI     notify removed`
      : `   Codex CLI     notify not found — skipping`
  );

  // Hooks written by collector versions that also supported Gemini CLI and
  // Antigravity. We no longer install these, but we still clean them up so an
  // upgraded user isn't left with a hook nothing removes.
  const legacyRemoved = LEGACY_HOOK_SETTINGS_PATHS.filter(
    (settingsPath) => unregisterJsonSessionEndHook(settingsPath) === "removed"
  );
  if (legacyRemoved.length > 0) {
    console.log(`✔  Legacy hooks  removed from ${legacyRemoved.length} file(s)`);
  }

  console.log("\nDone.");
}
