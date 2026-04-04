import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

/**
 * Get list of changed files (staged + unstaged) that match given extensions
 */
function getChangedFiles(extensions = [".js", ".ts", ".mjs", ".cjs"]) {
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
function runBiome(files, command = "format") {
  if (files.length === 0) {
    console.log("No changed files to process.");
    return 0;
  }

  console.log(`Running biome ${command} on ${files.length} changed file(s):`);
  files.forEach((f) => console.log(`  - ${f}`));

  try {
    const fileList = files.join(" ");
    execSync(`pnpm biome ${command} --write ${fileList}`, {
      stdio: "inherit",
      shell: true,
    });
    return 0;
  } catch (error) {
    return error.status || 1;
  }
}

// Main
const files = getChangedFiles();
const exitCode = runBiome(files, "format");
process.exit(exitCode);
