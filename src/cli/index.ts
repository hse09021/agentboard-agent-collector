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
  .command("status")
  .description("Show collector status and token usage stats")
  .action(async () => {
    const { statusCommand } = await import("./commands/status");
    await statusCommand();
  });

program
  .command("doctor")
  .description("Diagnose local configuration and environment")
  .action(async () => {
    const { doctorCommand } = await import("./commands/doctor");
    await doctorCommand();
  });

program
  .command("install-hooks")
  .description(
    "Register real-time session hooks with Claude Code, Codex CLI, and Antigravity CLI"
  )
  .option("--force", "Re-register even if hooks already exist")
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

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
