/**
 * Database migration runner
 * Usage: node scripts/migrate-db.js
 */
import { setupDatabase } from "../dist/src/infrastructure/db-migrations.js";

console.log("🔄 Starting database migration...\n");

const result = setupDatabase();

if (result.success) {
  console.log("✅", result.message);
  process.exit(0);
} else {
  console.error("❌", result.message);
  process.exit(1);
}
