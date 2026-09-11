/**
 * `agentboard sweep [on|off]`
 *
 * The cross-agent sweep is what makes a sub-agent running a *different* CLI
 * count at all — that CLI may have no agentboard hooks in its own config home,
 * so nothing ever fires for it, and the main agent's hook collects on its
 * behalf. Because that reaches sessions the user never explicitly instrumented,
 * it needs to be visible and switchable without hand-editing config.json.
 */

import chalk from "chalk";
import { loadConfigV2, saveConfigV2 } from "../../core/bindings";
import { listAgentHomes, type AgentHomeKind } from "../../core/agent-homes";

const KIND_LABEL: Record<AgentHomeKind, string> = {
  codex: "Codex CLI",
  claude_code: "Claude Code",
};

function printCoverage(): void {
  console.log("\nHomes covered:");
  let any = false;
  for (const kind of ["claude_code", "codex"] as AgentHomeKind[]) {
    for (const home of listAgentHomes(kind)) {
      any = true;
      console.log(`  ${KIND_LABEL[kind].padEnd(12)} ${home.dir}  ${chalk.dim(`[${home.origin}]`)}`);
    }
  }
  if (!any) console.log("  (none found)");
}

export async function sweepCommand(mode?: string): Promise<void> {
  const config = loadConfigV2();

  if (mode === undefined) {
    const state = config.sweep === "off" ? chalk.yellow("off") : chalk.green("registered");
    console.log(`Sweep: ${state}`);
    printCoverage();
    console.log(
      `\n${chalk.dim("Sessions in these homes are collected even when the agent that")}` +
        `\n${chalk.dim("wrote them has no agentboard hooks. Turn it off with `agentboard sweep off`.")}`
    );
    return;
  }

  const normalized = mode.toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    console.error(`✖  Unknown mode "${mode}". Use \`on\` or \`off\`.`);
    process.exit(1);
  }

  saveConfigV2({ ...config, sweep: normalized === "off" ? "off" : "registered" });

  if (normalized === "off") {
    console.log(`✔  Sweep is now ${chalk.yellow("off")}.`);
    console.log(
      chalk.dim(
        "   Only the session whose hook fired is collected. A sub-agent running a\n" +
          "   different CLI will go uncounted unless its own home has agentboard hooks."
      )
    );
  } else {
    console.log(`✔  Sweep is now ${chalk.green("registered")}.`);
    printCoverage();
  }
}
