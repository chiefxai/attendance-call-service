"use strict";

const express = require("express");
const { createAuthRouter } = require("./api/auth-router");
const http = require("node:http");
const {
  createCallServiceRouter,
  createPostgresPool,
  PostgresRepository,
  PostgresJobQueue,
  createVertexClientProvider,
  createMinioRecordingStore,
  loadConfig,
} = require("./index");

async function main() {
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  if (!organizationId) throw new Error("DEFAULT_ORGANIZATION_ID is required for standalone API mode");

  const config = loadConfig();
  const pool = createPostgresPool();
  const repository = new PostgresRepository(pool);
  const queue = new PostgresJobQueue(pool, {
    leaseMs: config.worker.leaseMs,
    defaultMaxAttempts: config.worker.maxAttempts,
    retry: config.worker.retry,
  });
  const getClientForOrg = createVertexClientProvider();
  const recordings = createMinioRecordingStore();
  const router = createCallServiceRouter({ express, repository, queue, getClientForOrg, recordings });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.get("/healthz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api/auth", createAuthRouter({ express, repository }));
  // Platform integrations authenticate with service keys; the web UI uses HttpOnly session cookies.
  app.use("/api/call-service", router);

  const server = http.createServer(app);
  server.on("upgrade", (request, socket, head) => {
    const handled = router.handleVobizUpgrade(request, socket, head);
    if (!handled) socket.destroy();
  });
  server.on("error", (error) => console.error("[attendance-api] server error", error.message));
  pool.on("error", (error) => console.error("[attendance-api] postgres pool error", error.message));

  const port = Number(process.env.PORT || 3000);
  const host = process.env.API_BIND_HOST || "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`[attendance-api] listening on ${host}:${port} for organization ${organizationId}`);

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[attendance-api] received ${signal}; shutting down`);
    server.close(async () => {
      router.closeVobizLiveRuntime();
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[attendance-api] failed to start", error);
  process.exitCode = 1;
});
