"use strict";

function backoffMilliseconds(attemptNumber, { initialMs = 5 * 60_000, multiplier = 1.2, maxMs = 30 * 60_000 } = {}) {
  const exponent = Math.max(0, Number(attemptNumber) - 1);
  return Math.min(maxMs, Math.round(initialMs * Math.pow(multiplier, exponent)));
}

class PostgresJobQueue {
  constructor(pool, { leaseMs = 60_000, defaultMaxAttempts = 8, retry = {} } = {}) {
    if (!pool?.connect) throw new Error("A PostgreSQL pool with connect() is required");
    this.pool = pool;
    this.leaseMs = leaseMs;
    this.defaultMaxAttempts = defaultMaxAttempts;
    this.retry = retry;
  }

  async transaction(operation) {
    if (typeof operation !== "function") throw new Error("A transaction operation is required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(jobType, payload, { idempotencyKey, runAt = new Date(), maxAttempts = this.defaultMaxAttempts, client } = {}) {
    if (!jobType || !idempotencyKey) throw new Error("jobType and idempotencyKey are required");
    const result = await (client || this.pool).query(
      `INSERT INTO attendance_jobs (job_type, payload, idempotency_key, run_at, max_attempts)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [jobType, JSON.stringify(payload || {}), idempotencyKey, runAt, maxAttempts],
    );
    return result.rows[0];
  }

  async reschedule(jobId, runAt = new Date()) {
    const result = await this.pool.query(
      `UPDATE attendance_jobs SET run_at=LEAST(run_at,$2), updated_at=NOW()
       WHERE id=$1 AND status='queued' RETURNING id`,
      [jobId, runAt],
    );
    return result.rowCount === 1;
  }

  async claim(workerId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH candidate AS (
           SELECT id FROM attendance_jobs
           WHERE (status = 'queued' AND run_at <= NOW())
              OR (status = 'running' AND lease_until < NOW())
           ORDER BY run_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE attendance_jobs j SET status = 'running', attempts = j.attempts + 1,
           lease_owner = $1, lease_until = NOW() + ($2 * INTERVAL '1 millisecond'), updated_at = NOW()
         FROM candidate WHERE j.id = candidate.id RETURNING j.*`,
        [workerId, this.leaseMs],
      );
      await client.query("COMMIT");
      return result.rows[0] || null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async complete(jobId, workerId) {
    const result = await this.pool.query(
      `UPDATE attendance_jobs SET status='done', completed_at=NOW(), lease_owner=NULL,
       lease_until=NULL, last_error=NULL, updated_at=NOW()
       WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING id`,
      [jobId, workerId],
    );
    if (!result.rowCount) throw new Error(`Job ${jobId} is no longer leased by ${workerId}`);
  }

  async fail(job, workerId, error) {
    const message = String(error?.message || error || "Job failed").slice(0, 4000);
    const dead = job.attempts >= job.max_attempts;
    const delayMs = backoffMilliseconds(job.attempts, this.retry);
    const result = await this.pool.query(
      `UPDATE attendance_jobs SET status=$3,
       run_at=CASE WHEN $3='queued' THEN NOW() + ($4 * INTERVAL '1 millisecond') ELSE run_at END,
       lease_owner=NULL, lease_until=NULL, last_error=$5, updated_at=NOW()
       WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING id`,
      [job.id, workerId, dead ? "dead" : "queued", delayMs, message],
    );
    if (!result.rowCount) throw new Error(`Job ${job.id} is no longer leased by ${workerId}`);
  }

  async heartbeat(jobId, workerId) {
    const result = await this.pool.query(
      `UPDATE attendance_jobs SET lease_until=NOW() + ($3 * INTERVAL '1 millisecond'), updated_at=NOW()
       WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING id`,
      [jobId, workerId, this.leaseMs],
    );
    return result.rowCount === 1;
  }
}

module.exports = { PostgresJobQueue, backoffMilliseconds };
