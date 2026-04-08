import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Get list of changed files (staged + unstaged) that match given extensions
 */
function getChangedFiles(extensions: string[] = [".js", ".ts", ".mjs", ".cjs"]): string[] {
  try {
    // Get staged files
    const staged = execSync("git diff --cached --name-only --diff-filter=ACM", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    // Get unstaged modified files
    const unstaged = execSync("git diff --name-only --diff-filter=ACM", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    // Get untracked files
    const untracked = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    const allFiles = new Set([
      ...staged.trim().split("\n").filter(Boolean),
      ...unstaged.trim().split("\n").filter(Boolean),
      ...untracked.trim().split("\n").filter(Boolean),
    ]);

    // Filter by extension and existence
    return Array.from(allFiles).filter((file) => {
      const ext = path.extname(file);
      return extensions.includes(ext) && existsSync(file);
    });
  } catch {
    return [];
  }
}

/**
 * Run Biome linter on specific files
 */
function runBiomeLint(files: string[], checkOnly: boolean = false): number {
  if (files.length === 0) {
    console.log("No changed files to lint.");
    return 0;
  }

  const action = checkOnly ? "checking" : "linting";
  console.log(`Biome ${action} ${files.length} changed file(s):`);
  files.forEach((f) => console.log(`  - ${f}`));

  try {
    const fileList = files.join(" ");
    const writeFlag = checkOnly ? "" : "--write";
    const options: ExecSyncOptions = {
      stdio: "inherit",
    };
    execSync(`pnpm biome lint ${writeFlag} ${fileList}`, options);
    return 0;
  } catch (error: unknown) {
    const exitCode = error && typeof error === "object" && "status" in error 
      ? (error.status as number) 
      : 1;
    return exitCode || 1;
  }
}

// Main
const checkOnly = process.argv.includes("check");
const files = getChangedFiles();
const exitCode = runBiomeLint(files, checkOnly);
process.exit(exitCode);
