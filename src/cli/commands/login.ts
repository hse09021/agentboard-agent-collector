import * as readline from "readline";
import { loadConfig, getOrCreateDeviceId, saveConfig } from "../../core/config";
import { generateDeviceId } from "../../core/device-id";
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
  let deviceId = getOrCreateDeviceId();
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
  const client = createApiClient(config.api_base_url, token);
  const register = (id: string) =>
    client.registerDevice({
      device_id: id,
      collector_version: COLLECTOR_VERSION,
      os: detectOS(),
    });

  try {
    try {
      await register(deviceId);
    } catch (err) {
      // 이 기기가 대시보드에서 연결 해제된 경우. 서버는 같은 device_id 의 재등록을
      // 영구히 거부하므로(revoke 가 되돌려지면 안 되니까) 새 id 로 연결해야 한다.
      //
      // 훅에서는 절대 하면 안 되는 일이지만 여기서는 맞다 — 사람이 방금 브라우저에서
      // 다시 인증했고, 그게 revoke 를 되돌릴 자격을 가진 유일한 행위다.
      if (!(err instanceof ApiError) || err.code !== "revoked_device") throw err;

      logger.warn(
        "This device was disconnected in AgentBoard. Reconnecting as a new device."
      );
      deviceId = generateDeviceId();
      await register(deviceId);
    }
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
