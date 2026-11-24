/**
 * `agentboard scope [all|listed]`, `agentboard track [dir]`,
 * `agentboard untrack [dir]` (#23)
 *
 * Which unconnected directories send usage to the default (community) server.
 * "all", the default, sends every one of them, as the collector always has.
 * "listed" sends only tracked directories, and only what was used after each
 * was added. Connected directories go to their organization either way.
 */

import chalk from "chalk";
import * as path from "path";
import { loadConfigV2, saveConfigV2 } from "../../core/bindings";
import type { CollectorConfigV2 } from "../../core/config-schema";
import {
  addTrackedDir,
  bindingCovering,
  defaultServerName,
  removeTrackedDir,
  setDefaultScope,
  trackedDirCovering,
} from "../../core/tracked-dirs";

function printTrackedDirs(config: CollectorConfigV2): void {
  console.log("\nTracked directories:");
  if (config.tracked_dirs.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const dir of config.tracked_dirs) {
    console.log(`  ${dir.abs_dir}  ${chalk.dim(`since ${dir.added_at}`)}`);
  }
}

function hintAllScope(config: CollectorConfigV2): void {
  console.log(
    chalk.dim(
      `   Scope is ${chalk.bold("all")}, so every unconnected directory goes to ${defaultServerName(config)} anyway.\n` +
        "   Run `agentboard scope listed` to send only tracked directories."
    )
  );
}

function warnIfConnected(config: CollectorConfigV2, dir: string): void {
  const binding = bindingCovering(config, dir);
  if (!binding) return;
  const where = binding.server.label ?? binding.project_label ?? binding.server.app_base_url;
  console.log(
    chalk.yellow(`!  This directory is connected to ${where}.`) +
      chalk.dim(`\n   Its usage goes there, not to ${defaultServerName(config)}, whatever the scope.`)
  );
}

export async function scopeCommand(mode?: string): Promise<void> {
  const config = loadConfigV2();
  const server = defaultServerName(config);

  if (mode === undefined) {
    if (config.default_scope === "listed") {
      console.log(`Scope: ${chalk.yellow("listed")} — only tracked directories send usage to ${server}.`);
    } else {
      console.log(`Scope: ${chalk.green("all")} — every unconnected directory sends usage to ${server}.`);
    }
    printTrackedDirs(config);
    console.log(
      chalk.dim(
        "\nConnected directories (`agentboard connect`) go to their organization either way.\n" +
          "Change with `agentboard scope all|listed`; manage the list with `agentboard track|untrack <dir>`."
      )
    );
    return;
  }

  const normalized = mode.trim().toLowerCase();
  if (normalized !== "all" && normalized !== "listed") {
    console.error(`✖  Unknown scope "${mode}". Use \`all\` or \`listed\`.`);
    process.exit(1);
  }

  saveConfigV2(setDefaultScope(config, normalized));

  if (normalized === "listed") {
    console.log(`✔  Scope is now ${chalk.yellow("listed")}. Only tracked directories send usage to ${server}.`);
    printTrackedDirs(config);
    if (config.tracked_dirs.length === 0) {
      console.log(
        chalk.yellow(`\n!  Nothing goes to ${server} until you run \`agentboard track <dir>\`.`)
      );
    }
    console.log(
      chalk.dim(
        "\n   Other directories stop sending from their next turn; what they use is never sent.\n" +
          "   Connected directories are unaffected."
      )
    );
  } else {
    console.log(`✔  Scope is now ${chalk.green("all")}. Every unconnected directory sends usage to ${server}.`);
    console.log(
      chalk.dim("   Usage withheld while the scope was listed is not sent; collection resumes from here.")
    );
  }
}

export async function trackCommand(dir: string = "."): Promise<void> {
  const config = loadConfigV2();
  const absDir = path.resolve(dir);
  const { config: next, tracked, alreadyTracked } = addTrackedDir(config, absDir);

  if (alreadyTracked) {
    console.log(`✔  ${tracked.abs_dir} is already tracked ${chalk.dim(`(since ${tracked.added_at})`)}.`);
  } else {
    saveConfigV2(next);
    console.log(`✔  Tracking ${chalk.cyan(tracked.abs_dir)}.`);
    console.log(
      chalk.dim(
        `   Usage from now on is sent to ${defaultServerName(next)} in listed scope; earlier usage is not.`
      )
    );
  }

  warnIfConnected(next, absDir);
  if (next.default_scope !== "listed") hintAllScope(next);
}

export async function untrackCommand(dir: string = "."): Promise<void> {
  const config = loadConfigV2();
  const absDir = path.resolve(dir);
  const { config: next, removed } = removeTrackedDir(config, absDir);

  if (!removed) {
    const parent = trackedDirCovering(config, absDir);
    if (parent) {
      console.log(
        chalk.yellow(`!  ${absDir} is not tracked itself; it is covered by ${parent.abs_dir}.`) +
          chalk.dim(`\n   Run \`agentboard untrack ${parent.abs_dir}\` to stop sending it.`)
      );
    } else {
      console.log(chalk.yellow(`!  ${absDir} is not tracked.`));
    }
    return;
  }

  saveConfigV2(next);
  console.log(`✔  No longer tracking ${chalk.cyan(removed.abs_dir)}.`);
  if (next.default_scope === "listed") {
    console.log(
      chalk.dim(
        `   Its sessions stop sending to ${defaultServerName(next)} from their next turn, including anything not yet sent.`
      )
    );
  } else {
    console.log(
      chalk.dim(
        `   Scope is ${chalk.bold("all")}, so it still sends to ${defaultServerName(next)} until you run \`agentboard scope listed\`.`
      )
    );
  }
}
