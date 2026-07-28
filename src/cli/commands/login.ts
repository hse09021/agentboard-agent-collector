import * as readline from "readline";
import { loadConfig, getOrCreateDeviceId, saveConfig } from "../../core/config";
import { saveToken, hasToken } from "../../platform/credential-store";
import { detectOS } from "../../platform/os";
import { ApiError, createApiClient } from "../../api/client";
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

export async function loginCommand(options: { force?: boolean } = {}): Promise<void> {
  if (hasToken() && !options.force) {
    logger.warn(
      "Already logged in. Run `agentboard login --force` to re-authenticate."
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

  // 토큰은 서버가 받아준 뒤에만 저장한다. 먼저 저장해 버리면 인증에 실패해도
  // `hasToken()`이 true가 되어 status/doctor/hook이 "로그인됨"으로 동작한다.
  try {
    const client = createApiClient(config.api_base_url, token);
    await client.registerDevice({
      device_id: deviceId,
      collector_version: COLLECTOR_VERSION,
      os: detectOS(),
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      logger.error(
        "Login failed: the server rejected that token (invalid or expired). " +
          "Re-open the login URL and paste the token again."
      );
    } else if (err instanceof ApiError) {
      logger.error(
        `Login failed: server returned HTTP ${err.status}. Token was not saved.`
      );
    } else {
      // 네트워크 오류/타임아웃 — 토큰이 유효한지 확인할 수 없으므로 저장하지 않는다.
      logger.error(
        `Login failed: could not reach ${config.api_base_url}. ` +
          "Token was not saved — check your connection and try again."
      );
    }
    process.exit(1);
  }

  saveToken(token);
  saveConfig({ device_id: deviceId });
  logger.success("Device registered with AgentBoard.");

  logger.plain("");
  logger.success("Logged in successfully.");
  logger.plain(`Device ID: ${chalk.dim(deviceId)}`);
}
