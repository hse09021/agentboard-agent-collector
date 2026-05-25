import chalk from "chalk";

const debugEnabled = process.env.AGENTBOARD_DEBUG === "1";

export const logger = {
  info(message: string): void {
    console.log(chalk.blue("ℹ"), message);
  },

  success(message: string): void {
    console.log(chalk.green("✓"), message);
  },

  warn(message: string): void {
    console.warn(chalk.yellow("⚠"), message);
  },

  error(message: string): void {
    console.error(chalk.red("✗"), message);
  },

  debug(message: string): void {
    if (debugEnabled) {
      console.log(chalk.gray("[debug]"), message);
    }
  },

  plain(message: string): void {
    console.log(message);
  },
};
