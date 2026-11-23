"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PostgresJobQueue } = require("../src/infrastructure/database/postgres-queue");

test("permanent ChiefVoice template failures mark the job dead without retry", async () => {
  let args;
  const pool = {
    connect: async () => ({ query: async () => ({}), release() {} }),
    query: async (...values) => { args = values; return { rowCount: 1 }; },
  };
  const queue = new PostgresJobQueue(pool);
  const error = Object.assign(new Error("ChiefVoice API returned HTTP 403: template is not assigned"), {
    status: 403, retryable: false,
  });
  await queue.fail({ id: "job-1", attempts: 1, max_attempts: 8 }, "worker-1", error);
  assert.equal(args[1][2], "dead");
  assert.equal(args[1][4], error.message);
});

