import chalk from "chalk";

export const logger = {
  success(message: string): void {
    console.log(chalk.green("✓"), message);
  },

  warn(message: string): void {
    console.warn(chalk.yellow("⚠"), message);
  },

  error(message: string): void {
    console.error(chalk.red("✗"), message);
  },

  plain(message: string): void {
    console.log(message);
  },
};
