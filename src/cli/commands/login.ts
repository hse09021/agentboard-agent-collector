import * as readline from "readline";
import { loadConfig, getOrCreateDeviceId, saveConfig } from "../../core/config";
import { saveToken, hasToken } from "../../platform/credential-store";
import { detectOS } from "../../platform/os";
import { createApiClient } from "../../api/client";
import { COLLECTOR_VERSION } from "../../core/usage-event";
import { logger } from "../../core/logger";
import chalk from "chalk";

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function loginCommand(): Promise<void> {
  if (hasToken()) {
    logger.warn(
      "Already logged in. Run `agentboard logout` first to re-authenticate."
    );
    return;
  }

  const config = loadConfig();
  const deviceId = getOrCreateDeviceId();
  const loginUrl = new URL("/cli/login", config.app_base_url);
  loginUrl.searchParams.set("device_id", deviceId);

  logger.plain("");
  logger.plain(chalk.bold("AgentBoard Login"));
  logger.plain("─".repeat(50));
  logger.plain("");
  logger.plain("1. Open the following URL in your browser:");
  logger.plain("");
  logger.plain(chalk.cyan(`  ${loginUrl.toString()}`));
  logger.plain("");
  logger.plain("2. Log in and copy the auth token shown on the page.");
  logger.plain("");

  const token = await prompt("Paste your auth token here: ");

  if (!token) {
    logger.error("No token provided. Login cancelled.");
    process.exit(1);
  }

  saveToken(token);

  try {
    const client = createApiClient(config.api_base_url, token);
    await client.registerDevice({
      device_id: deviceId,
      collector_version: COLLECTOR_VERSION,
      os: detectOS(),
    });
    logger.success("Device registered with AgentBoard.");
  } catch {
    logger.warn(
      "Could not register device with server (offline or invalid token). " +
        "Token saved locally — run `agentboard doctor` to diagnose."
    );
  }

  saveConfig({ device_id: deviceId });

  logger.plain("");
  logger.success("Logged in successfully.");
  logger.plain(`Device ID: ${chalk.dim(deviceId)}`);
}
