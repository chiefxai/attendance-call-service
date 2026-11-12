"use strict";

require("dotenv/config");

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
  createAthulyaScheduleSyncHandler,
  latestDueAthulyaSyncSlot,
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
  const postCallAgent = createAttendancePostCallAgent({
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.VERTEX_SUMMARY_LOCATION || "global",
  });
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
    additionalHandlers: {
      sync_athulya_schedules: createAthulyaScheduleSyncHandler({ repository }),
    },
  });
  const worker = startWorkers({ queue, handlers, ...config.worker });
  let stopping = false;
  const autoSyncIntervalMs = Math.max(15_000, Number(process.env.ATHULYA_AUTO_SYNC_SCAN_INTERVAL_MS) || 60_000);
  let schedulingAthulyaSync = false;
  async function scheduleAthulyaSyncs() {
    if (schedulingAthulyaSync || stopping) return;
    schedulingAthulyaSync = true;
    try {
      const organizations = await repository.listAutoSyncAthulyaIntegrations();
      for (const integration of organizations) {
        const slot = latestDueAthulyaSyncSlot(new Date(), {
          timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
          enabledAt: integration.autoSyncEnabledAt,
        });
        if (!slot || (integration.lastAutoSyncSlot && integration.lastAutoSyncSlot >= slot.key)) continue;
        const scope = integration.autoSyncScope || "all";
        const scopeId = String(integration.autoSyncScopeId || "").trim();
        const scheduleDate = slot.key.slice(0, 10);
        if (scope !== "all" && !scopeId) {
          console.error(`[attendance-worker] skipping automatic Athulya sync: missing ${scope} ID organization=${integration.organizationId}`);
          continue;
        }
        const filters = {
          from_date: scheduleDate,
          to_date: scheduleDate,
          ...(scope === "branch" ? { branch_id: scopeId }
            : scope === "care_manager" ? { care_manager_id: scopeId } : {}),
        };
        await queue.transaction(async (client) => {
          const runId = await repository.enqueueScheduledAthulyaSync({
            organizationId: integration.organizationId, slotKey: slot.key, slotAt: slot.at,
            filters, scope, scopeId, client,
          });
          if (!runId) return;
          await queue.enqueue("sync_athulya_schedules", {
            runId, organizationId: integration.organizationId, filters,
          }, {
            idempotencyKey: `athulya-auto-sync:${integration.organizationId}:${slot.key}`,
            client,
          });
          console.info(`[attendance-worker] queued Athulya schedule sync organization=${integration.organizationId} scope=${scope}${scopeId ? `:${scopeId}` : ""} slot=${slot.key}`);
        });
      }
    } catch (error) {
      console.error("[attendance-worker] Athulya automatic sync scheduling failed", error.message);
    } finally {
      schedulingAthulyaSync = false;
    }
  }
  const autoSyncTimer = setInterval(() => { void scheduleAthulyaSyncs(); }, autoSyncIntervalMs);
  autoSyncTimer.unref?.();
  void scheduleAthulyaSyncs();
  async function purgeExpiredInboundCalls() {
    const expired = await repository.listExpiredInboundCalls(100);
    for (const call of expired) {
      try {
        if (call.recordingObjectKey) await recordings.deleteObject(call.recordingObjectKey);
        for (const key of call.appointmentRecordingKeys || []) await recordings.deleteObject(key);
        await repository.deleteExpiredInboundCall(call.id);
        console.info(`[attendance-worker] purged expired inbound call ${call.id}`);
      } catch (error) {
        console.error(`[attendance-worker] inbound retention purge failed call=${call.id}`, error.message);
      }
    }
  }
  const retentionIntervalMs = Number(process.env.RETENTION_SCAN_INTERVAL_MS);
  const retentionTimer = setInterval(() => purgeExpiredInboundCalls().catch((error) => {
    console.error("[attendance-worker] inbound retention scan failed", error.message);
  }), Number.isSafeInteger(retentionIntervalMs) && retentionIntervalMs >= 60_000 ? retentionIntervalMs : 60 * 60 * 1000);
  retentionTimer.unref?.();
  void purgeExpiredInboundCalls().catch((error) => console.error("[attendance-worker] inbound retention scan failed", error.message));
  pool.on("error", (error) => console.error("[attendance-worker] postgres pool error", error.message));
  console.log(`[attendance-worker] started ${worker.workerIds.length} consumers`);
  const reconcileIntervalMs = Math.max(1_000, Number(process.env.OVERDUE_CALL_RECONCILE_INTERVAL_MS) || 15_000);
  let reconcilingOverdueCalls = false;
  async function reconcileOverdueCalls() {
    if (reconcilingOverdueCalls || stopping) return;
    reconcilingOverdueCalls = true;
    try {
      const dueCalls = await repository.listDueFollowUpCalls(100);
      for (const due of dueCalls) {
        if (due.hasRunningJob) continue;
        const noAnswerCount = due.reason === "employee_requested_callback" ? 0
          : due.lastAttemptStatus === "noanswer" ? due.lastNoAnswerBefore + 1 : due.lastNoAnswerBefore;
        if (due.reason !== "employee_requested_callback" && noAnswerCount >= config.callRetry.maxConsecutiveNoAnswer) {
          await repository.setStageStatus(due.sessionId, due.stage, "not_answered", {
            reason: "consecutive_no_answer_limit_reached", consecutiveNoAnswer: noAnswerCount,
          });
          await queue.enqueue("evaluate_session", { sessionId: due.sessionId, stage: due.stage }, {
            idempotencyKey: `evaluate:${due.sessionId}:not-answered:${due.stage}`,
          });
          console.warn(`[attendance-worker] stopped overdue retries at no-answer limit session=${due.sessionId} stage=${due.stage} count=${noAnswerCount}`);
          continue;
        }
        const attemptNumber = due.queuedAttemptNumber
          || Math.max(due.maxCallAttempt, due.maxJobAttempt) + 1;
        const consecutiveNoAnswer = due.reason === "employee_requested_callback"
          ? 0
          : due.lastAttemptStatus === "noanswer" ? due.lastNoAnswerBefore + 1 : due.lastNoAnswerBefore;
        const payload = {
          sessionId: due.sessionId,
          taskId: due.taskId,
          stage: due.stage,
          attemptNumber,
          consecutiveNoAnswer,
        };
        const recovered = due.queuedJobId
          ? await queue.reschedule(due.queuedJobId, new Date())
          : await queue.enqueue("place_call", payload, {
            idempotencyKey: `call:${due.sessionId}:${due.stage}:${attemptNumber}`,
            runAt: new Date(),
          });
        if (recovered) {
          console.warn(`[attendance-worker] recovered overdue call session=${due.sessionId} stage=${due.stage} attempt=${attemptNumber} dueAt=${due.dueAt}`);
        }
      }
    } catch (error) {
      console.error("[attendance-worker] overdue call reconciliation failed", error.message);
    } finally {
      reconcilingOverdueCalls = false;
    }
  }
  const overdueCallTimer = setInterval(() => { void reconcileOverdueCalls(); }, reconcileIntervalMs);
  overdueCallTimer.unref?.();
  void reconcileOverdueCalls();


  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    clearInterval(overdueCallTimer);
    clearInterval(autoSyncTimer);
    console.log(`[attendance-worker] received ${signal}; shutting down`);
    clearInterval(retentionTimer);
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
