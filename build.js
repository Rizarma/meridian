import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = __dirname;
const distDir = path.join(rootDir, "dist");

// Files and directories to exclude from copying
const exclude = ["node_modules", "dist", ".git", ".env", "tsconfig.json", "build.js"];

function shouldCopy(itemPath) {
  const relativePath = path.relative(rootDir, itemPath);
  const basename = path.basename(itemPath);

  // Check if any part of the path matches excluded items
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (exclude.includes(part)) return false;
  }

  // Only copy JSON and SQL files (config files and migrations)
  if (fs.statSync(itemPath).isFile() && !basename.endsWith(".json") && !basename.endsWith(".sql")) {
    return false;
  }

  return true;
}

function copyDir(src, dst) {
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true });
  }

  for (const item of fs.readdirSync(src)) {
    const srcPath = path.join(src, item);
    const dstPath = path.join(dst, item);

    if (!shouldCopy(srcPath)) continue;

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
      console.log(`Copied: ${path.relative(rootDir, srcPath)}`);
    }
  }
}

console.log("Copying assets to dist/...");
copyDir(rootDir, distDir);

// Validate that required assets were copied
const requiredFiles = ["src/infrastructure/db/migrations/postgres/schema.sql"];

let missing = false;
for (const file of requiredFiles) {
  const distPath = path.join(distDir, file);
  if (!fs.existsSync(distPath)) {
    console.error(`\nERROR: Required asset missing from dist/: ${file}`);
    missing = true;
  }
}

if (missing) {
  console.error("\nBuild failed: one or more required assets were not copied to dist/.");
  process.exit(1);
}

console.log("Build complete!");
