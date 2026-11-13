"use strict";

function number(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig() {
  return {
    worker: {
      concurrency: number("QUEUE_WORKER_CONCURRENCY", 4),
      pollMs: number("QUEUE_POLL_MS", 500),
      leaseMs: number("QUEUE_LEASE_MS", 60_000),
      maxAttempts: number("QUEUE_MAX_ATTEMPTS", 8),
      retry: {
        initialMs: number("QUEUE_RETRY_INITIAL_MS", 1000),
        multiplier: number("QUEUE_RETRY_MULTIPLIER", 2),
        maxMs: number("QUEUE_RETRY_MAX_MS", 60_000),
      },
    },
    callRetry: {
      maxConsecutiveNoAnswer: number("CALL_MAX_CONSECUTIVE_NO_ANSWER", 3),
      initialMinutes: number("CALL_RETRY_INITIAL_MINUTES", 3),
      multiplier: number("CALL_RETRY_MULTIPLIER", 1.2),
      maxMinutes: number("CALL_RETRY_MAX_MINUTES", 30),
      recordingWaitMs: number("RECORDING_READY_POLL_MS", 15_000),
      recordingWaitMaxAttempts: number("RECORDING_READY_MAX_POLLS", 4),
    },
    callCapacity: {
      maxConcurrentCalls: number("MAX_CONCURRENT_CALLS", 20),
      capacityPollMs: number("CALL_CAPACITY_POLL_MS", 2_000),
      slotTtlMinutes: number("CALL_SLOT_TTL_MINUTES", 180),
    },
  };
}

module.exports = { loadConfig };
