"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createPostgresPool } = require("../src/infrastructure/database/postgres-pool");

async function main() {
  const pool = createPostgresPool();
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS service_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const migrationDir = path.join(__dirname, "..", "migrations");
    const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const prior = await pool.query("SELECT 1 FROM service_schema_migrations WHERE version=$1", [version]);
      if (prior.rowCount) {
        console.log(`[attendance-migrate] ${version} already applied`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO service_schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        console.log(`[attendance-migrate] applied ${version}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[attendance-migrate] failed", error);
  process.exitCode = 1;
});
