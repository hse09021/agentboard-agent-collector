import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, getConfigDir, getHookSentPath } from "../../core/config";
import { hasToken, loadToken } from "../../platform/credential-store";
import { createApiClient } from "../../api/client";
import { COLLECTOR_VERSION } from "../../core/usage-event";
import { logger } from "../../core/logger";
import chalk from "chalk";

interface CheckResult {
  label: string;
  ok: boolean;
  message: string;
}

async function runChecks(): Promise<CheckResult[]> {
  const config = loadConfig();
  const results: CheckResult[] = [];

  // 1. Auth token
  const tokenPresent = hasToken();
  results.push({
    label: "Auth token",
    ok: tokenPresent,
    message: tokenPresent
      ? "Token found"
      : "Not logged in — run `agentboard login`",
  });

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
    const client = createApiClient(config.api_base_url, token);
    const healthy = await client.checkHealth().catch(() => false);
    results.push({
      label: "API connectivity",
      ok: healthy,
      message: healthy
        ? `${config.api_base_url} reachable`
        : `Cannot reach ${config.api_base_url}`,
    });
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

  // 6. Hook registration checks
  const home = os.homedir();
  const hookChecks: Array<{ label: string; file: string }> = [
    {
      label: "Hook: claude_code",
      file: path.join(home, ".claude", "settings.json"),
    },
    {
      label: "Hook: gemini_cli",
      file: path.join(home, ".gemini", "settings.json"),
    },
    {
      label: "Hook: codex",
      file: path.join(home, ".codex", "config.toml"),
    },
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

  return results;
}

export async function doctorCommand(): Promise<void> {
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
