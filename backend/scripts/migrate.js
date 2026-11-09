"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createPostgresPool } = require("../src/infrastructure/database/postgres-pool");

async function main() {
  const pool = createPostgresPool();
  const migration = {
    version: "001_attendance_schema",
    file: path.join(__dirname, "..", "migrations", "001_attendance_schema.sql"),
  };
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS service_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const prior = await pool.query("SELECT 1 FROM service_schema_migrations WHERE version=$1", [migration.version]);
    if (prior.rowCount) {
      console.log(`[attendance-migrate] ${migration.version} already applied`);
      return;
    }
    const sql = await fs.readFile(migration.file, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO service_schema_migrations(version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
      console.log(`[attendance-migrate] applied ${migration.version}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[attendance-migrate] failed", error);
  process.exitCode = 1;
});
