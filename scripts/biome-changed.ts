import { type ExecSyncOptions, execSync } from "node:child_process";
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
 * Run Biome on specific files
 */
function runBiome(files: string[], command: string = "format"): number {
  if (files.length === 0) {
    console.log("No changed files to process.");
    return 0;
  }

  console.log(`Running biome ${command} on ${files.length} changed file(s):`);
  for (const f of files) console.log(`  - ${f}`);

  try {
    const fileList = files.join(" ");
    const options: ExecSyncOptions = {
      stdio: "inherit",
    };
    execSync(`pnpm biome ${command} --write ${fileList}`, options);
    return 0;
  } catch (error: unknown) {
    const exitCode =
      error && typeof error === "object" && "status" in error ? (error.status as number) : 1;
    return exitCode || 1;
  }
}

// Main
const files = getChangedFiles();
const exitCode = runBiome(files, "format");
process.exit(exitCode);
