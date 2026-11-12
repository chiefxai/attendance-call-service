"use strict";

const crypto = require("node:crypto");
const { createPostgresPool } = require("../src/infrastructure/database/postgres-pool");
const { PostgresRepository } = require("../src/infrastructure/database/postgres-repository");
const { normalizeIndianMobile } = require("../src/domain/attendance/phone-number");

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk.toString();
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("Input must be a JSON array of Care Manager records.");
  return records;
}

function prepareManagers(records, expectedCount, temporaryPassword) {
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 100) {
    throw new Error("Set CARE_MANAGER_PROVISION_EXPECTED_COUNT to the approved account count.");
  }
  if (records.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} approved Care Manager records; received ${records.length}.`);
  }
  const ids = new Set();
  const phones = new Set();
  return records.map((record) => {
    const athulyaId = String(record?.athulyaCareManagerId ?? record?.id ?? "").trim();
    const name = String(record?.name ?? "").trim().replace(/\s+/g, " ");
    const phone = normalizeIndianMobile(record?.phone);
    if (!athulyaId || athulyaId.length > 100 || !name || name.length > 200 || !phone) {
      throw new Error("Each record needs a Care Manager ID, name, and valid Indian mobile number.");
    }
    if (ids.has(athulyaId)) throw new Error(`Duplicate Care Manager ID: ${athulyaId}.`);
    if (phones.has(phone)) throw new Error(`A mobile number is assigned to more than one record: ${phone}.`);
    ids.add(athulyaId);
    phones.add(phone);
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(temporaryPassword, passwordSalt, 64).toString("hex");
    return { athulyaId, name, phone, passwordSalt, passwordHash };
  });
}

async function main() {
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  if (!organizationId) throw new Error("DEFAULT_ORGANIZATION_ID is required.");
  const temporaryPassword = String(process.env.CARE_MANAGER_DEFAULT_PASSWORD || "");
  if (!temporaryPassword || temporaryPassword.length > 1024) throw new Error("Supply CARE_MANAGER_DEFAULT_PASSWORD privately when running this command.");
  const records = await readInput();
  const managers = prepareManagers(records, Number(process.env.CARE_MANAGER_PROVISION_EXPECTED_COUNT), temporaryPassword);
  const pool = createPostgresPool();
  try {
    const repository = new PostgresRepository(pool);
    const created = await repository.provisionCareManagerAccounts({ organizationId, managers });
    console.log(`[attendance-auth] provisioned ${created.length} Care Manager accounts; each must change the temporary password at first sign-in.`);
    console.log(created.map(({ athulyaId }) => `Care Manager ID ${athulyaId}: provisioned`).join("\n"));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[attendance-auth] Care Manager provisioning failed:", error.message);
  process.exitCode = 1;
});
