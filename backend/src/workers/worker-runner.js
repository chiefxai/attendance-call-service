"use strict";

const os = require("node:os");
const crypto = require("node:crypto");

function startWorkers({ queue, handlers, concurrency = 4, pollMs = 500, workerPrefix = os.hostname() } = {}) {
  if (!queue || !handlers) throw new Error("queue and handlers are required");
  let stopping = false;
  const workerIds = Array.from({ length: concurrency }, (_, index) => `${workerPrefix}-${index}-${crypto.randomUUID()}`);

  async function run(workerId) {
    while (!stopping) {
      let job;
      try { job = await queue.claim(workerId); }
      catch (error) {
        console.error("[attendance-worker] claim failed", error.message);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const heartbeat = setInterval(() => {
        queue.heartbeat(job.id, workerId).catch((error) => {
          console.error("[attendance-worker] lease heartbeat failed", error.message);
        });
      }, Math.max(1000, Math.floor((queue.leaseMs || 60_000) / 3)));
      heartbeat.unref?.();
      try {
        const handler = handlers[job.job_type];
        if (!handler) throw new Error(`No handler registered for job type ${job.job_type}`);
        await handler(job.payload, { job, queue, workerId });
        await queue.complete(job.id, workerId);
      } catch (error) {
        console.error(`[attendance-worker] ${job.job_type} failed`, error.message);
        try { await queue.fail(job, workerId, error); }
        catch (queueError) { console.error("[attendance-worker] could not update failed job", queueError.message); }
      } finally { clearInterval(heartbeat); }
    }
  }

  const running = workerIds.map(run);
  return {
    workerIds,
    async stop() {
      stopping = true;
      await Promise.all(running);
    },
  };
}

module.exports = { startWorkers };
