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

function getCodexHooksJsonPath(): string {
  return path.join(HOME, ".codex", "hooks.json");
}

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

// ─── Generic JSON hook registration (SessionEnd, Stop, …) ─────────────────────

type HookResult = "added" | "already-registered" | "skipped";

// Recognizes a hook this collector wrote, across formats/versions: the script
// path may live in `command` (older single-string form) or in `args` (current
// form, where `command` is the node executable), and older entries carry a
// name of "agentboard-*".
function isAgentboardHook(h: Record<string, unknown>): boolean {
  const commandMatch =
    typeof h.command === "string" &&
    (h.command.includes("agentboard") || h.command.includes("session-end.mjs"));
  const nameMatch = typeof h.name === "string" && h.name.includes("agentboard");
  const argsMatch =
    Array.isArray(h.args) &&
    h.args.some(
      (a) => typeof a === "string" && a.includes("session-end.mjs")
    );
  return commandMatch || nameMatch || argsMatch;
}

function registerJsonHook(
  settingsPath: string,
  eventName: string,
  hookEntry: Record<string, unknown>
): HookResult {
  const settings = readJson(settingsPath);

  if (typeof settings.hooks !== "object" || settings.hooks === null) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks[eventName])) {
    hooks[eventName] = [];
  }
  const eventArray = hooks[eventName] as Array<Record<string, unknown>>;

  // Already pointing at the exact current script + command? Just make sure the
  // group has a matcher field and we're done.
  const desiredScript = Array.isArray(hookEntry.args)
    ? hookEntry.args[0]
    : undefined;
  for (const group of eventArray) {
    if (!Array.isArray(group.hooks)) continue;
    for (const h of group.hooks as Array<Record<string, unknown>>) {
      if (!isAgentboardHook(h)) continue;
      const script = Array.isArray(h.args) ? h.args[0] : undefined;
      if (h.command === hookEntry.command && script === desiredScript) {
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

  // Otherwise re-point: strip every stale agentboard hook (old path or command
  // format, e.g. from a version before the scripts moved into claude/) so an
  // upgraded install stops firing a script that no longer exists, then add a
  // fresh entry.
  for (const group of eventArray) {
    if (!Array.isArray(group.hooks)) continue;
    group.hooks = (group.hooks as Array<Record<string, unknown>>).filter(
      (h) => !isAgentboardHook(h)
    );
  }
  hooks[eventName] = eventArray.filter(
    (g) => !Array.isArray(g.hooks) || (g.hooks as unknown[]).length > 0
  );
  (hooks[eventName] as Array<Record<string, unknown>>).push({
    matcher: "",
    hooks: [hookEntry],
  });

  try {
    writeJson(settingsPath, settings);
    return "added";
  } catch {
    return "skipped";
  }
}

function unregisterJsonHook(
  settingsPath: string,
  eventName: string
): "removed" | "not-found" {
  if (!fs.existsSync(settingsPath)) return "not-found";

  const settings = readJson(settingsPath);
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks[eventName])) return "not-found";

  const before = (hooks[eventName] as unknown[]).length;
  hooks[eventName] = (
    hooks[eventName] as Array<Record<string, unknown>>
  )
    .map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      group.hooks = (
        group.hooks as Array<Record<string, unknown>>
      ).filter((h) => !isAgentboardHook(h));
      return group;
    })
    .filter(
      (group) =>
        !Array.isArray(group.hooks) ||
        (group.hooks as unknown[]).length > 0
    );

  if ((hooks[eventName] as unknown[]).length === before) return "not-found";

  try {
    writeJson(settingsPath, settings);
    return "removed";
  } catch {
    return "not-found";
  }
}

// ─── Claude Code hooks ────────────────────────────────────────────────────────
//
// Registered on two events, same script for both:
//   Stop       — fires each time Claude finishes a response, so usage shows up
//                on the dashboard per turn (like Codex's notify hook) instead
//                of only when the session closes.
//   SessionEnd — final sweep at session close, catching anything accrued after
//                the last Stop (e.g. subagent usage). The worker uploads deltas,
//                so the two events never double-count.
const CLAUDE_HOOK_EVENTS = ["Stop", "SessionEnd"] as const;

function claudeHookEntry(nodeExe: string, scriptPath: string) {
  return {
    type: "command",
    command: nodeExe,
    args: [scriptPath],
    name: "agentboard-session-end",
    timeout: 10,
  };
}

function registerClaudeHook(nodeExe: string, scriptPath: string): HookResult {
  const results = CLAUDE_HOOK_EVENTS.map((event) =>
    registerJsonHook(getClaudeSettingsPath(), event, claudeHookEntry(nodeExe, scriptPath))
  );
  // One combined verdict for reporting: any write failure wins, then any
  // addition (upgrades from SessionEnd-only installs land here), else no-op.
  if (results.includes("skipped")) return "skipped";
  if (results.includes("added")) return "added";
  return "already-registered";
}

function unregisterClaudeHook(): "removed" | "not-found" {
  const results = CLAUDE_HOOK_EVENTS.map((event) =>
    unregisterJsonHook(getClaudeSettingsPath(), event)
  );
  return results.includes("removed") ? "removed" : "not-found";
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

  const newLine = buildCodexNotifyLine(nodePath, notifyScript);

  // Already pointing at the exact current line? Nothing to do. Otherwise fall
  // through and re-write, so an upgraded install whose script path changed
  // (e.g. moved into codex/) gets re-pointed instead of left stale.
  if (existing.split("\n").some((l) => l.trim() === newLine.trim())) {
    return "already-registered";
  }

  const cleaned = existing
    .split("\n")
    .filter((l) => !/^\s*notify\s*=/.test(l))
    .join("\n");

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

// ─── Codex hooks.json registration (SessionEnd + SubagentStop) ────────────────
//
// The legacy `notify` line (config.toml) only fires per turn on the parent
// session. The newer hooks.json system additionally exposes `SessionEnd` (final
// rate-limit snapshot / residue sweep) and `SubagentStop` (subagent tokens live
// in separate child rollouts the parent never sees). Command hooks receive the
// payload as JSON on stdin. `notify` is kept for back-compat with older Codex
// builds that predate hooks.json; on those, this file is simply ignored.

// A hooks.json command hook object has no name field, so ours are recognized by
// the script path in the command string (the package path contains "agentboard"
// and the basenames are collector-specific).
function isAgentboardCommand(cmd: unknown): boolean {
  return (
    typeof cmd === "string" &&
    (cmd.includes("agentboard") ||
      cmd.includes("subagent-stop.mjs") ||
      cmd.includes("session-end.mjs"))
  );
}

function codexHookCommand(nodePath: string, scriptPath: string): string {
  return `${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)}`;
}

function registerCodexJsonHooks(
  nodePath: string,
  sessionEndScript: string,
  subagentStopScript: string
): HookResult {
  const hooksPath = getCodexHooksJsonPath();
  let root: Record<string, unknown> = {};
  if (fs.existsSync(hooksPath)) {
    try {
      root = readJson(hooksPath);
    } catch {
      root = {};
    }
  }
  if (typeof root.hooks !== "object" || root.hooks === null) root.hooks = {};
  const hooks = root.hooks as Record<string, unknown>;

  const desired: Array<[string, string]> = [
    ["SessionEnd", codexHookCommand(nodePath, sessionEndScript)],
    ["SubagentStop", codexHookCommand(nodePath, subagentStopScript)],
  ];

  let changed = false;
  for (const [event, command] of desired) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const arr = hooks[event] as Array<Record<string, unknown>>;

    const present = arr.some(
      (g) =>
        Array.isArray(g.hooks) &&
        (g.hooks as Array<Record<string, unknown>>).some(
          (h) => h.command === command
        )
    );
    if (present) continue;

    // Re-point: strip any stale agentboard entry (old path/format) for this
    // event, then add a fresh one — mirrors the JSON/settings re-point.
    for (const g of arr) {
      if (Array.isArray(g.hooks)) {
        g.hooks = (g.hooks as Array<Record<string, unknown>>).filter(
          (h) => !isAgentboardCommand(h.command)
        );
      }
    }
    hooks[event] = arr.filter(
      (g) => !Array.isArray(g.hooks) || (g.hooks as unknown[]).length > 0
    );
    (hooks[event] as Array<Record<string, unknown>>).push({
      hooks: [{ type: "command", command, timeout: 30 }],
    });
    changed = true;
  }

  if (!changed) return "already-registered";
  try {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    writeJson(hooksPath, root);
    return "added";
  } catch {
    return "skipped";
  }
}

function unregisterCodexJsonHooks(): "removed" | "not-found" {
  const hooksPath = getCodexHooksJsonPath();
  if (!fs.existsSync(hooksPath)) return "not-found";

  let root: Record<string, unknown>;
  try {
    root = readJson(hooksPath);
  } catch {
    return "not-found";
  }
  const hooks = root.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return "not-found";

  let removed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const arr = hooks[event] as Array<Record<string, unknown>>;
    for (const g of arr) {
      if (!Array.isArray(g.hooks)) continue;
      const before = (g.hooks as unknown[]).length;
      g.hooks = (g.hooks as Array<Record<string, unknown>>).filter(
        (h) => !isAgentboardCommand(h.command)
      );
      if ((g.hooks as unknown[]).length !== before) removed = true;
    }
    hooks[event] = arr.filter(
      (g) => !Array.isArray(g.hooks) || (g.hooks as unknown[]).length > 0
    );
  }

  if (!removed) return "not-found";
  try {
    writeJson(hooksPath, root);
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
  const sessionEndScript = path.join(hooksDir, "claude", "session-end.mjs");
  const codexNotifyScript = path.join(hooksDir, "codex", "codex-notify.mjs");
  const codexSessionEndScript = path.join(hooksDir, "codex", "session-end.mjs");
  const codexSubagentStopScript = path.join(hooksDir, "codex", "subagent-stop.mjs");

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
      console.log(`✔  Claude Code   → ${claudePath} (Stop + SessionEnd)`);
    } else if (result === "already-registered") {
      console.log(`   Claude Code   already registered — skipping`);
    } else {
      console.warn(`⚠  Claude Code   → could not write ${claudePath}`);
    }
  }

  // ── Codex CLI ────────────────────────────────────────────────────────────
  let codexHooksJsonAdded = false;
  if (!isCodexInstalled()) {
    console.log(`   Codex CLI     not installed — skipping`);
  } else {
    if (options.force) {
      unregisterCodexHook();
      unregisterCodexJsonHooks();
    }
    const result = registerCodexHook(nodePath, codexNotifyScript);
    const codexPath = getCodexConfigPath();
    if (result === "added") {
      console.log(`✔  Codex CLI     → ${codexPath} (notify)`);
    } else if (result === "already-registered") {
      console.log(`   Codex CLI     notify already registered — skipping`);
    } else {
      console.warn(`⚠  Codex CLI     → could not write ${codexPath}`);
    }

    // Newer Codex builds also support hooks.json: SessionEnd (final rate-limit
    // snapshot) and SubagentStop (subagent tokens). Older builds ignore it.
    const jsonResult = registerCodexJsonHooks(
      nodePath,
      codexSessionEndScript,
      codexSubagentStopScript
    );
    const hooksJsonPath = getCodexHooksJsonPath();
    if (jsonResult === "added") {
      console.log(`✔  Codex CLI     → ${hooksJsonPath} (SessionEnd + SubagentStop)`);
      codexHooksJsonAdded = true;
    } else if (jsonResult === "already-registered") {
      console.log(`   Codex CLI     hooks.json already registered — skipping`);
    } else {
      console.warn(`⚠  Codex CLI     → could not write ${hooksJsonPath}`);
    }
  }

  console.log(
    "\nDone. Sessions will be reported automatically after each AI session ends.\n" +
      "Run `agentboard uninstall-hooks` to remove the hooks."
  );
  if (codexHooksJsonAdded) {
    console.log(
      "\nNote: Codex requires you to review and trust new hooks. Run `/hooks` inside\n" +
        "Codex (or restart it) and approve the agentboard hooks so they will fire."
    );
  }
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

  const codexJsonResult = unregisterCodexJsonHooks();
  console.log(
    codexJsonResult === "removed"
      ? `✔  Codex CLI     hooks.json (SessionEnd + SubagentStop) removed`
      : `   Codex CLI     hooks.json not found — skipping`
  );

  console.log("\nDone.");
}
