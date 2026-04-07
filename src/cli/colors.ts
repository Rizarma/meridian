import chalk from "chalk";

export const colors = {
  // Info
  info: chalk.blue,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,

  // Text styles
  bold: chalk.bold,
  dim: chalk.dim,
  italic: chalk.italic,
  underline: chalk.underline,

  // Colors
  cyan: chalk.cyan,
  magenta: chalk.magenta,
  gray: chalk.gray,
  white: chalk.white,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,

  // Special
  heading: chalk.bold.cyan,
  prompt: chalk.cyan,
  value: chalk.yellow,
  command: chalk.green,
};

// Helper for section headers
export function header(text: string): string {
  return colors.heading(`\n── ${text} ${"─".repeat(Math.max(0, 50 - text.length))}`);
}

// Helper for success messages
export function success(text: string): string {
  return colors.success(`✓ ${text}`);
}

// Helper for warning messages
export function warning(text: string): string {
  return colors.warning(`⚠ ${text}`);
}

// Helper for error messages
export function error(text: string): string {
  return colors.error(`✗ ${text}`);
}

// Helper for info messages
export function info(text: string): string {
  return colors.info(`ℹ ${text}`);
}
