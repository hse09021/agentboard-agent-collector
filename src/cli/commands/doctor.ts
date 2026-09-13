import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, getConfigDir, getHookSentPath } from "../../core/config";
import {
  hasToken,
  loadCredential,
  loadToken,
  loadTokenBundle,
  listCredentialRefs,
} from "../../platform/credential-store";
import { reportProjectCredentials } from "../../core/project-credential-status";
import {
  describeCredential,
  formatCredentialStatus,
  isCredentialHealthy,
} from "../../core/credential-status";
import { readAuthFailure, describeAuthFailure } from "../../core/auth-failure";
import { loadConfigV2, findOrphans } from "../../core/bindings";
import { scanAllGhostSessions, removeGhostSessions } from "../../core/ghost-sessions";
import { listAgentHomes } from "../../core/agent-homes";
import { createDefaultRouteClient } from "../../api/client";
import { COLLECTOR_VERSION } from "../../core/usage-event";
import { logger } from "../../core/logger";
import chalk from "chalk";

interface CheckResult {
  label: string;
  ok: boolean;
  message: string;
}

/**
 * Reads the sweep's state file directly rather than importing
 * plugin/hooks/lib/sweep.mjs — the hooks are ESM and this CLI compiles to
 * CommonJS, the same reason routing/path-normalize/atomic-write each exist in
 * both forms. Only two fields are read, so a copy is cheaper than a third
 * mirrored module.
 */
function readSweepState(): { lastSweepFinishedAt?: string; lastReport?: Record<string, unknown> } {
  const file = path.join(getConfigDir(), "sweep-state.json");
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return raw && raw.version === 1 ? raw : {};
  } catch {
    return {};
  }
}

async function runChecks(): Promise<CheckResult[]> {
  const config = loadConfig();
  const results: CheckResult[] = [];

  // 1. Auth token
  //
  // Checking that the file exists tells us nothing useful: an expired token
  // sits on disk exactly like a valid one, so every upload could be failing
  // with a 401 while this check stayed green. Decode the expiry locally —
  // no signature verification needed, and none is possible here anyway.
  const tokenPresent = hasToken();
  if (!tokenPresent) {
    results.push({
      label: "Auth token",
      ok: false,
      message: "Not logged in — run `agentboard login`",
    });
  } else {
    // With rotation there is more to report than a single expiry date: an
    // expired ACCESS token is normal between renewals, so what decides the
    // verdict is whether renewal is still possible.
    const status = describeCredential(loadTokenBundle());
    results.push({
      label: "Auth token",
      ok: isCredentialHealthy(status),
      message: formatCredentialStatus(status),
    });
  }

  // 1b. Authentication failures recorded by hooks.
  //
  // Hooks run in the background, so a refresh the server refused is invisible
  // until something surfaces it here — otherwise collection just stops.
  const authFailure = readAuthFailure();
  if (authFailure) {
    results.push({
      label: "Hook auth",
      ok: false,
      message: `${describeAuthFailure(authFailure)} — run \`agentboard login\``,
    });
  }

  // 2. Config directory
  const configDir = getConfigDir();
  const configDirExists = fs.existsSync(configDir);
  results.push({
    label: "Config directory",
    ok: configDirExists,
    message: configDirExists ? configDir : "Directory not found",
  });

  // 3. hook-sent.json writability
  const sentPath = getHookSentPath();
  let sentOk = true;
  let sentMsg = "Writable";
  try {
    if (fs.existsSync(sentPath)) {
      fs.accessSync(sentPath, fs.constants.R_OK | fs.constants.W_OK);
    } else {
      const tmpPath = sentPath + ".tmp";
      fs.writeFileSync(tmpPath, "", { mode: 0o600 });
      fs.unlinkSync(tmpPath);
    }
  } catch {
    sentOk = false;
    sentMsg = "hook-sent.json not writable";
  }
  results.push({ label: "Sent-session log", ok: sentOk, message: sentMsg });

  // 4. API connectivity
  const token = loadToken();
  if (token) {
    const client = createDefaultRouteClient(config.api_base_url, token);
    const healthy = await client.checkHealth().catch(() => false);
    results.push({
      label: "API connectivity",
      ok: healthy,
      message: healthy
        ? `${config.api_base_url} reachable`
        : `Cannot reach ${config.api_base_url}`,
    });

    // 연결이 끊긴 기기는 업로드할 때만 403으로 드러난다. 훅이 조용히 죽어 있으면
    // 사용자는 대시보드가 왜 멈췄는지 알 길이 없으므로 여기서 먼저 알려준다.
    if (healthy) {
      const deviceId = config.device_id;
      const devices = await client.getDevices().catch(() => null);
      const thisDevice = devices?.find((d) => d.device_id === deviceId);

      if (devices === null) {
        results.push({
          label: "Device registration",
          ok: false,
          message: "Could not read the device list from the server",
        });
      } else if (!deviceId || !thisDevice) {
        results.push({
          label: "Device registration",
          ok: false,
          message: "This device is not registered — run `agentboard login`",
        });
      } else {
        results.push({
          label: "Device registration",
          ok: !thisDevice.revoked,
          message: thisDevice.revoked
            ? "Disconnected in AgentBoard — run `agentboard login` to reconnect"
            : `Registered${thisDevice.last_usage_at ? "" : " (no usage uploaded yet)"}`,
        });
      }
    }
  } else {
    results.push({
      label: "API connectivity",
      ok: false,
      message: "Skipped (not logged in)",
    });
  }

  // 5. Collector version
  results.push({
    label: "Collector version",
    ok: true,
    message: `v${COLLECTOR_VERSION}`,
  });

  // 6. Hook registration checks — one row per agent home, not one per tool.
  // An agent an orchestrator launched against a relocated CODEX_HOME /
  // CLAUDE_CONFIG_DIR has its own settings file, and whether OUR hooks are in
  // THAT file is the thing that actually determines if it gets collected.
  const hookChecks: Array<{ label: string; file: string }> = [
    ...listAgentHomes("claude_code").map((h) => ({
      label: `Hook: claude_code (${h.origin})`,
      file: path.join(h.dir, "settings.json"),
    })),
    ...listAgentHomes("codex").map((h) => ({
      label: `Hook: codex (${h.origin})`,
      file: path.join(h.dir, "config.toml"),
    })),
  ];

  for (const { label, file } of hookChecks) {
    let registered = false;
    let message = `Not registered — run \`agentboard install-hooks\``;
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf-8");
        if (content.includes("agentboard")) {
          registered = true;
          message = "Registered";
          if (file.endsWith(".json")) {
            const parsed = JSON.parse(content);
            const sessionEndGroups: Array<Record<string, unknown>> =
              parsed?.hooks?.SessionEnd ?? [];
            const hasAgentBoardGroup = sessionEndGroups.some((g) => {
              const hks = Array.isArray(g.hooks)
                ? (g.hooks as Array<Record<string, unknown>>)
                : [];
              return hks.some(
                (h) =>
                  (typeof h.command === "string" &&
                    (h.command.includes("agentboard") ||
                      h.command.includes("session-end.mjs"))) ||
                  (typeof h.name === "string" && h.name.includes("agentboard"))
              );
            });
            const matcherOk = sessionEndGroups.some((g) => {
              const hks = Array.isArray(g.hooks)
                ? (g.hooks as Array<Record<string, unknown>>)
                : [];
              const isAgentBoard = hks.some(
                (h) =>
                  (typeof h.command === "string" &&
                    (h.command.includes("agentboard") ||
                      h.command.includes("session-end.mjs"))) ||
                  (typeof h.name === "string" && h.name.includes("agentboard"))
              );
              return isAgentBoard && typeof g.matcher === "string";
            });
            if (hasAgentBoardGroup && !matcherOk) {
              registered = false;
              message =
                "Missing matcher field — run `agentboard install-hooks` to fix";
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    results.push({ label, ok: registered, message });
  }

  // 6.5 Sweep coverage.
  //
  // This is the honest-disclosure line. The sweep collects sessions from homes
  // whose agent has no agentboard hooks at all, which is exactly how a
  // different-CLI sub-agent gets counted — and exactly why the user should be
  // able to see the reach at a glance, and turn it off.
  const v2ForSweep = loadConfigV2();
  const sweptHomes = [...listAgentHomes("claude_code"), ...listAgentHomes("codex")];
  const hookedCount = sweptHomes.filter((h) => {
    const file =
      h.kind === "codex" ? path.join(h.dir, "config.toml") : path.join(h.dir, "settings.json");
    try {
      return fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("agentboard");
    } catch {
      return false;
    }
  }).length;

  if (v2ForSweep.sweep === "off") {
    results.push({
      label: "Sweep",
      ok: true,
      message:
        sweptHomes.length > hookedCount
          ? `off — sessions in ${sweptHomes.length - hookedCount} home(s) are NOT collected`
          : "off",
    });
  } else {
    const state = readSweepState();
    const last = state.lastSweepFinishedAt
      ? `last run ${new Date(state.lastSweepFinishedAt).toLocaleString()}`
      : "not run yet";
    results.push({
      label: "Sweep",
      ok: true,
      message:
        `registered — ${sweptHomes.length} home(s) covered ` +
        `(${hookedCount} hooked, ${sweptHomes.length - hookedCount} sweep-only), ${last}`,
    });
  }

  // 7. Connected projects
  //
  // The single most useful line when someone asks "why is my work not showing
  // up in the org dashboard" — almost always the answer is that the directory
  // was never connected, so the data went to the community server instead.
  const v2 = loadConfigV2();
  results.push({
    label: "Connected projects",
    ok: true,
    message:
      v2.bindings.length === 0
        ? "None — all usage goes to the community server"
        : v2.bindings
            .map((b) => `${b.project_label ?? b.abs_dir} -> ${b.server.label ?? b.server.app_base_url}`)
            .join("; "),
  });

  // 8. Credential/binding consistency
  //
  // `connect` writes the credential first and the binding last, so an
  // interruption leaves one without the other. Neither is dangerous, but a
  // binding without a credential silently stops uploading.
  const orphans = findOrphans(v2, listCredentialRefs());
  const orphanCount =
    orphans.bindingsWithoutCredential.length + orphans.credentialsWithoutBinding.length;
  results.push({
    label: "Credentials",
    ok: orphans.bindingsWithoutCredential.length === 0,
    message:
      orphanCount === 0
        ? "Consistent"
        : `${orphans.bindingsWithoutCredential.length} binding(s) missing a credential, ` +
          `${orphans.credentialsWithoutBinding.length} unused credential(s)`,
  });

  // 8b. Connected project credentials
  //
  // Hooks renew them before they expire. What is left to catch is a machine
  // that went unused past the expiry, and a renewal the server refused (revoked
  // device, left the organization, archived project) — both of which otherwise
  // end collection without a single visible error.
  for (const row of reportProjectCredentials(v2.bindings, loadCredential)) {
    results.push({ label: `Project ${row.label}`, ok: row.ok, message: row.message });
  }

  // 9. Leftover /usage transcripts
  //
  // v0.7.0 stops creating these, but the ones already on disk still clutter the
  // /resume picker. Reported only — they belong to Claude Code, so removal is
  // never automatic.
  const ghosts = scanAllGhostSessions();
  if (!ghosts.missingRoot) {
    results.push({
      label: "Session list",
      ok: ghosts.ghosts.length === 0,
      message:
        ghosts.ghosts.length === 0
          ? "No leftover /usage sessions"
          : `${ghosts.ghosts.length} leftover /usage session(s) from older collector versions — ` +
            `run \`agentboard doctor --clean-sessions\` to remove them`,
    });
  }

  return results;
}

export async function doctorCommand(
  options: { cleanSessions?: boolean } = {}
): Promise<void> {
  if (options.cleanSessions) {
    await cleanGhostSessions();
    return;
  }

  logger.plain("");
  logger.plain(chalk.bold("AgentBoard Doctor — Diagnostics"));
  logger.plain("─".repeat(50));
  logger.plain("");

  const results = await runChecks();
  let allOk = true;

  for (const result of results) {
    const icon = result.ok ? chalk.green("✓") : chalk.red("✗");
    const label = result.label.padEnd(24);
    logger.plain(`  ${icon}  ${label}  ${chalk.dim(result.message)}`);
    if (!result.ok) allOk = false;
  }

  logger.plain("");
  if (allOk) {
    logger.success("All checks passed.");
  } else {
    logger.warn("Some checks failed. See details above.");
  }
  logger.plain("");
}

/**
 * Removes the /usage transcripts left behind by collector versions before
 * v0.7.0.
 *
 * These files belong to Claude Code, so this only ever runs when explicitly
 * asked for, prints what it is about to delete, and re-verifies each file
 * immediately before removing it.
 */
async function cleanGhostSessions(): Promise<void> {
  const scan = scanAllGhostSessions();

  logger.plain("");
  logger.plain(chalk.bold("Clean leftover /usage sessions"));
  logger.plain("-".repeat(50));
  logger.plain("");

  if (scan.missingRoot) {
    logger.warn("Claude Code session directory not found — nothing to clean.");
    return;
  }
  if (scan.ghosts.length === 0) {
    logger.success(`No leftover sessions. ${scan.keptCount} real session(s) untouched.`);
    return;
  }

  const totalKb = scan.ghosts.reduce((n, g) => n + g.sizeBytes, 0) / 1024;
  logger.plain(
    `Found ${chalk.bold(String(scan.ghosts.length))} leftover /usage session(s) ` +
      `(${totalKb.toFixed(1)} KB). ${scan.keptCount} real session(s) will be kept.`
  );
  logger.plain("");

  const { removed, failed } = removeGhostSessions(scan.ghosts);

  logger.success(`Removed ${removed.length} leftover session(s).`);
  for (const f of failed) {
    logger.warn(`  Kept ${f.filePath}: ${f.reason}`);
  }
  logger.plain("");
}
