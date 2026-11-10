"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { createPostgresPool } = require("../src/infrastructure/database/postgres-pool");
const { PostgresRepository } = require("../src/infrastructure/database/postgres-repository");

async function main() {
  const [rawEmail = "", rawName = "", rawPassword = ""] = (await fs.readFile(0, "utf8")).split(/\r?\n/);
  const email = rawEmail.trim().toLowerCase();
  const password = rawPassword;
  const displayName = rawName.trim() || email;
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new Error("Provide a valid email as the first input line.");
  if (password.length < 12 || password.length > 1024) throw new Error("Password must be at least 12 characters.");
  if (!organizationId) throw new Error("DEFAULT_ORGANIZATION_ID is required.");
  const pool = createPostgresPool();
  try {
    const repository = new PostgresRepository(pool);
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    const user = await repository.createWebUser({
      organizationId, email, displayName, passwordSalt: salt, passwordHash,
    });
    console.log(`[attendance-auth] created web user ${user.email} for organization ${organizationId}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[attendance-auth] user provisioning failed:", error.message);
  process.exitCode = 1;
});
