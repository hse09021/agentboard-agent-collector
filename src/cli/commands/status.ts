import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, getConfigDir, getHookSentPath } from "../../core/config";
import { hasToken, loadToken } from "../../platform/credential-store";
import { COLLECTOR_VERSION } from "../../core/usage-event";
import { createApiClient } from "../../api/client";
import { UsageSummary, UsageBySource } from "../../api/types";
import { logger } from "../../core/logger";
import chalk from "chalk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hookSentCount(): number {
  const sentPath = getHookSentPath();
  if (!fs.existsSync(sentPath)) return 0;
  try {
    return Object.keys(JSON.parse(fs.readFileSync(sentPath, "utf-8"))).length;
  } catch {
    return 0;
  }
}

function isHookRegistered(
  settingsPath: string,
  checkFn: (content: string) => boolean
): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    return checkFn(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtSource(source: string): string {
  const names: Record<string, string> = {
    claude: "Claude Code",
    claude_code: "Claude Code",
    gemini: "Gemini CLI ",
    gemini_cli: "Gemini CLI ",
    codex: "Codex CLI  ",
    opencode: "OpenCode   ",
    github_copilot: "GH Copilot ",
  };
  return names[source] ?? source.padEnd(11);
}

function bar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return (
    chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(width - filled))
  );
}

function renderUsageTable(
  summary: UsageSummary,
  bySource: UsageBySource[],
  periodLabel: string
): void {
  logger.plain(chalk.bold(`  ${periodLabel}`));
  logger.plain(`  ${"─".repeat(58)}`);

  if (bySource.length === 0) {
    logger.plain(chalk.dim("  No usage data for this period."));
  } else {
    logger.plain(
      `  ${chalk.dim("Agent")}         ` +
        `${chalk.dim("Tokens".padStart(9))}  ` +
        `${chalk.dim("Sessions".padStart(8))}  ` +
        `${chalk.dim("Cost".padStart(9))}  ` +
        chalk.dim("Share")
    );
    logger.plain(`  ${"─".repeat(58)}`);

    for (const row of bySource) {
      const pct = row.percentage;
      logger.plain(
        `  ${chalk.white(fmtSource(row.source))}  ` +
          `${chalk.cyan(fmtTokens(row.total_tokens).padStart(9))}  ` +
          `${String(row.session_count).padStart(8)}  ` +
          `${chalk.yellow(fmtCost(row.estimated_cost_usd).padStart(9))}  ` +
          `${bar(pct, 14)} ${pct.toFixed(1)}%`
      );
    }

    logger.plain(`  ${"─".repeat(58)}`);
    logger.plain(
      `  ${"Total".padEnd(13)}  ` +
        `${chalk.bold(chalk.cyan(fmtTokens(summary.total_tokens).padStart(9)))}  ` +
        `${String(summary.session_count).padStart(8)}  ` +
        `${chalk.bold(chalk.yellow(fmtCost(summary.estimated_cost_usd).padStart(9)))}  ` +
        `${chalk.dim(
          `${summary.active_days} active day${summary.active_days !== 1 ? "s" : ""}`
        )}`
    );
  }
  logger.plain("");
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const loggedIn = hasToken();

  logger.plain("");
  logger.plain(chalk.bold("AgentBoard Collector Status"));
  logger.plain("─".repeat(40));
  logger.plain("");

  const authStatus = loggedIn
    ? chalk.green("Logged in")
    : chalk.red("Not logged in");
  logger.plain(`Auth:            ${authStatus}`);
  logger.plain(`Device ID:       ${chalk.dim(config.device_id ?? "(not set)")}`);
  logger.plain(`Collector:       v${COLLECTOR_VERSION}`);
  logger.plain(`Sessions sent:   ${chalk.cyan(String(hookSentCount()))}`);
  logger.plain("");

  // ── Hook registration status ─────────────────────────────────────────────
  logger.plain(chalk.bold("Hooks"));
  logger.plain("─".repeat(40));

  const home = os.homedir();
  const hooks: Array<{ name: string; registered: boolean }> = [
    {
      name: "Claude Code",
      registered: isHookRegistered(
        path.join(home, ".claude", "settings.json"),
        (c) => c.includes("agentboard")
      ),
    },
    {
      name: "Gemini CLI  ",
      registered: isHookRegistered(
        path.join(home, ".gemini", "settings.json"),
        (c) => c.includes("agentboard")
      ),
    },
    {
      name: "Codex CLI   ",
      registered: isHookRegistered(
        path.join(home, ".codex", "config.toml"),
        (c) => c.includes("agentboard")
      ),
    },
    {
      name: "OpenCode    ",
      registered: isHookRegistered(
        path.join(home, ".config", "opencode", "config.json"),
        (c) => c.includes("agentboard")
      ),
    },
  ];

  for (const { name, registered } of hooks) {
    const icon = registered ? chalk.green("✔") : chalk.dim("○");
    const label = registered
      ? chalk.green("Registered")
      : chalk.dim("Not registered");
    logger.plain(`  ${icon}  ${name}  ${label}`);
  }

  const anyRegistered = hooks.some((h) => h.registered);
  if (!anyRegistered) {
    logger.plain("");
    logger.plain(
      chalk.yellow(
        `  → Run ${chalk.bold("agentboard install-hooks")} to enable real-time collection.`
      )
    );
  }

  logger.plain("");
  logger.plain(`API endpoint:    ${chalk.dim(config.api_base_url)}`);
  logger.plain("");

  // ── Token usage stats ────────────────────────────────────────────────────
  if (!loggedIn) {
    logger.plain(chalk.dim("Log in to see token usage statistics."));
    logger.plain("");
    return;
  }

  const token = loadToken();
  const client = createApiClient(config.api_base_url, token!);

  logger.plain(chalk.bold("Token Usage"));
  logger.plain("─".repeat(40));
  logger.plain("");

  try {
    const [weekSummary, weekBySource, monthSummary, monthBySource] =
      await Promise.all([
        client.getUsageSummary("week"),
        client.getUsageBySource("week"),
        client.getUsageSummary("month"),
        client.getUsageBySource("month"),
      ]);

    renderUsageTable(weekSummary, weekBySource, "This week");
    renderUsageTable(monthSummary, monthBySource, "This month");
  } catch {
    logger.warn("Could not fetch usage data. Check your connection or run `agentboard doctor`.");
    logger.plain("");
  }
}
