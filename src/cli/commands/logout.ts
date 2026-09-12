import {
  deleteToken,
  hasToken,
  loadTokenBundle,
} from "../../platform/credential-store";
import { revokeRefreshToken } from "../../api/token-refresh";
import { loadConfig } from "../../core/config";
import { clearAuthFailure } from "../../core/auth-failure";
import { logger } from "../../core/logger";
import chalk from "chalk";

export async function logoutCommand(): Promise<void> {
  if (!hasToken()) {
    logger.warn("Not currently logged in.");
    return;
  }

  const bundle = loadTokenBundle();
  let revokeWarning: string | null = null;

  // Deleting the file locally does not stop the refresh token from working:
  // anyone holding a copy could keep minting access tokens until it expires.
  // So ask the server to burn the family first.
  if (bundle?.refresh) {
    const config = loadConfig();
    const result = await revokeRefreshToken(config.api_base_url, bundle.refresh);
    if (!result.ok) revokeWarning = result.reason ?? "unknown error";
  }

  // Local state goes regardless. A user who runs `logout` offline must not be
  // left logged in because the server could not be reached.
  deleteToken();
  clearAuthFailure();

  logger.plain("");
  if (revokeWarning) {
    logger.warn(
      `Could not tell the server to revoke this session (${revokeWarning}). ` +
        "Local credentials were removed; the refresh token stays valid until it expires."
    );
  }
  logger.success("Logged out successfully.");
  logger.plain(chalk.dim("Auth token removed from local storage."));
}
