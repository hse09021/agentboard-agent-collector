import { deleteToken, hasToken } from "../../platform/credential-store";
import { logger } from "../../core/logger";
import chalk from "chalk";

export async function logoutCommand(): Promise<void> {
  if (!hasToken()) {
    logger.warn("Not currently logged in.");
    return;
  }

  deleteToken();

  logger.plain("");
  logger.success("Logged out successfully.");
  logger.plain(chalk.dim("Auth token removed from local storage."));
}
