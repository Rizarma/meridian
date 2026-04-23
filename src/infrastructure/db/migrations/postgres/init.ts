import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initPostgresSchema(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { ssl: "require" });

  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");

    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await sql.unsafe(statement + ";");
    }

    console.log("Postgres schema initialized successfully");
  } finally {
    await sql.end();
  }
}
