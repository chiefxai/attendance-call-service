"use strict";

const {
  createAttendanceHandlers,
  createAttendancePostCallAgent,
  createMinioRecordingStore,
  createPostgresPool,
  createVertexClientProvider,
  createVertexTranscriber,
  createVobizClient,
  loadConfig,
  PostgresJobQueue,
  PostgresRepository,
  startWorkers,
  createAttendanceBackendClient,
} = require("../index");

async function main() {
  const config = loadConfig();
  const pool = createPostgresPool();
  const repository = new PostgresRepository(pool);
  const queue = new PostgresJobQueue(pool, {
    leaseMs: config.worker.leaseMs,
    defaultMaxAttempts: config.worker.maxAttempts,
    retry: config.worker.retry,
  });
  const vobiz = createVobizClient();
  const getClientForOrg = createVertexClientProvider();
  const recordings = createMinioRecordingStore();
  const transcriber = createVertexTranscriber({
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.VERTEX_TRANSCRIPTION_LOCATION || "global",
    recordings,
  });
  const postCallAgent = createAttendancePostCallAgent({ getClientForOrg });
  const backend = createAttendanceBackendClient();
  const handlers = createAttendanceHandlers({
    repository,
    queue,
    vobiz,
    recordings,
    transcriber,
    postCallAgent,
    backend,
    retry: config.callRetry,
    capacity: config.callCapacity,
  });
  const worker = startWorkers({ queue, handlers, ...config.worker });
  pool.on("error", (error) => console.error("[attendance-worker] postgres pool error", error.message));
  console.log(`[attendance-worker] started ${worker.workerIds.length} consumers`);

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[attendance-worker] received ${signal}; shutting down`);
    await worker.stop();
    await pool.end();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[attendance-worker] failed to start", error);
  process.exitCode = 1;
});
