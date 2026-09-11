#!/usr/bin/env node

import { Command } from "commander";
import { COLLECTOR_VERSION } from "../core/usage-event";

const program = new Command();

program
  .name("agentboard")
  .description("Agent usage collector — track AI coding tool usage privately")
  .version(COLLECTOR_VERSION);

program
  .command("login")
  .description("Authenticate and register this device")
  .option("--force", "Replace an existing saved auth token")
  .action(async (options) => {
    const { loginCommand } = await import("./commands/login");
    await loginCommand(options);
  });

program
  .command("logout")
  .description("Remove local auth state")
  .action(async () => {
    const { logoutCommand } = await import("./commands/logout");
    await logoutCommand();
  });

program
  .command("connect")
  .argument("[dir]", "Project directory to connect (defaults to the current one)", ".")
  .description("Connect a project directory to an organization server")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (dir, options) => {
    const { connectCommand } = await import("./commands/connect");
    await connectCommand(dir, options);
  });

program
  .command("disconnect")
  .argument("[dir]", "Project directory to disconnect (defaults to the current one)", ".")
  .description("Stop sending a project directory to its organization server")
  .action(async (dir) => {
    const { disconnectCommand } = await import("./commands/connect");
    await disconnectCommand(dir);
  });

program
  .command("status")
  .description("Show collector status and token usage stats")
  .action(async () => {
    const { statusCommand } = await import("./commands/status");
    await statusCommand();
  });

program
  .command("doctor")
  .description("Diagnose local configuration and environment")
  .option(
    "--clean-sessions",
    "Remove leftover /usage transcripts created by collector versions before 0.7.0"
  )
  .action(async (options) => {
    const { doctorCommand } = await import("./commands/doctor");
    await doctorCommand(options);
  });

program
  .command("install-hooks")
  .description(
    "Register real-time session hooks with Claude Code and Codex CLI"
  )
  .option("--force", "Re-register even if hooks already exist")
  .option(
    "--home <dir>",
    "Additional agent config home to install into (repeatable)",
    (value: string, previous: string[] = []) => previous.concat(value)
  )
  .option("--only-default-home", "Install only into ~/.claude and ~/.codex")
  .action(async (options) => {
    const { installHooksCommand } = await import("./commands/install-hooks");
    await installHooksCommand(options);
  });

program
  .command("uninstall-hooks")
  .description("Remove previously registered session hooks from all AI tools")
  .action(async () => {
    const { uninstallHooksCommand } = await import("./commands/install-hooks");
    await uninstallHooksCommand();
  });

program
  .command("sweep")
  .description("Show or change cross-agent sweep coverage (on by default)")
  .argument("[mode]", "on | off — omit to show the current setting")
  .action(async (mode?: string) => {
    const { sweepCommand } = await import("./commands/sweep");
    await sweepCommand(mode);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
