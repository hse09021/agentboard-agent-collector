import * as readline from "readline";
import { loadConfig, getOrCreateDeviceId, saveConfig } from "../../core/config";
import { generateDeviceId } from "../../core/device-id";
import { saveToken, loadTokenBundle } from "../../platform/credential-store";
import { parsePastedToken, describePasteProblem } from "../paste-token";
import { clearAuthFailure } from "../../core/auth-failure";
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
  const stored = loadTokenBundle();

  // ★ "이미 로그인됨" 은 갱신 가능한 자격증명을 들고 있을 때만 참이다.
  //
  // 예전에는 hasToken() 으로, 즉 파일이 있는지만 보고 조기 리턴했다. 레거시
  // 단일 JWT 를 들고 업그레이드한 사용자는 그 파일 때문에 여기서 막혔고,
  // v=2 로그인 URL 이 화면에 뜰 기회 자체가 없었다. 레거시 토큰은 회전할 수
  // 없으므로(refresh 가 없다) 스스로 새 형식으로 넘어갈 방법도 없다 —
  // 만료되는 날 수집이 조용히 끊길 때까지 영영 레거시로 남는다.
  //
  // 그래서 레거시는 "로그인됨" 으로 치지 않고 그대로 흐름을 태운다.
  if (stored?.refresh && !options.force) {
    logger.warn(
      "Already logged in. Run `agentboard login --force` to re-authenticate."
    );
    return;
  }

  const upgradingLegacy = Boolean(stored && !stored.refresh);

  if (upgradingLegacy && !options.force) {
    // 사용자는 방금 전까지 멀쩡히 쓰고 있었다. 이유 없이 재인증을 요구하면
    // 버그로 읽히므로, 왜 다시 로그인해야 하는지 먼저 말한다.
    logger.warn(
      "This device is signed in with an older token that cannot be renewed " +
        "automatically. Signing in again upgrades it — your usage history is " +
        "not affected."
    );
    logger.plain("");
  }

  const config = loadConfig();
  let deviceId = getOrCreateDeviceId();
  const loginUrl = new URL("/cli/login", config.app_base_url);
  loginUrl.searchParams.set("device_id", deviceId);
  // v=2 asks for an access/refresh PAIR. The path itself is a public contract
  // and does not change: a server that does not know the parameter simply
  // serves the old single-JWT page, which parsePastedToken still accepts.
  loginUrl.searchParams.set("v", "2");

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

  const pasted = await prompt("Paste your auth token here: ");

  const parsed = parsePastedToken(pasted);
  if (!parsed.ok) {
    logger.error(describePasteProblem(parsed.problem));
    process.exit(1);
  }
  const bundle = parsed.bundle;
  const token = bundle.access;

  if (!bundle.refresh) {
    // An older server, or the legacy login page. Collection still works; it
    // just stops when the token expires instead of rotating.
    logger.warn(
      "This server issued a token without automatic renewal — you will need to " +
        "run `agentboard login` again when it expires."
    );
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
    // 전환에 실패해도 기존 자격증명은 건드리지 않았다(저장은 등록 성공 뒤에만
    // 한다). 레거시 사용자에게는 이 말이 중요하다 — 업그레이드하려다 로그아웃된
    // 줄 알면 수집이 멀쩡한데도 손을 대게 된다.
    if (upgradingLegacy) {
      logger.plain(
        chalk.dim("Your existing sign-in is unchanged — collection continues.")
      );
    }
    process.exit(1);
  }

  saveToken(bundle);
  saveConfig({ device_id: deviceId });
  // A successful login is exactly what a recorded hook auth failure was asking
  // for, so drop it rather than leave status/doctor warning about a fixed problem.
  clearAuthFailure();
  logger.success("Device registered with AgentBoard.");

  logger.plain("");
  logger.success("Logged in successfully.");
  logger.plain(`Device ID: ${chalk.dim(deviceId)}`);
}
