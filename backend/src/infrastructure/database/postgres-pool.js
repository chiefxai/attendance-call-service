"use strict";

const { Pool } = require("pg");

function createPostgresPool(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString,
    max: Number(options.max || process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || process.env.PG_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || process.env.PG_CONNECT_TIMEOUT_MS || 5_000),
    ...(options.ssl ? { ssl: options.ssl } : {}),
  });
}

module.exports = { createPostgresPool };
