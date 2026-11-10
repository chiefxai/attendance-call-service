"use strict";

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

const operationSchemas = [
  {
    key: "place_call",
    name: "place_outbound_call",
    description: "Place one scheduled outbound employee call through the existing guarded call workflow.",
    schema: z.object({
      sessionId: z.string(),
      stage: z.enum(["check_in", "check_out"]),
      attemptNumber: z.number().int().positive(),
      capacityWaitCount: z.number().int().nonnegative().optional(),
      consecutiveNoAnswer: z.number().int().nonnegative().optional(),
    }),
  },
  {
    key: "process_call_result",
    name: "process_call_result",
    description: "Process a provider call result and enqueue recording or retry work according to service policy.",
    schema: z.object({ callAttemptId: z.string() }),
  },
  {
    key: "wait_for_recording",
    name: "wait_for_call_recording",
    description: "Check whether the provider recording is ready and enqueue the next recording poll when needed.",
    schema: z.object({ callAttemptId: z.string(), pollNumber: z.number().int().positive() }),
  },
  {
    key: "transcribe_call",
    name: "transcribe_call_recording",
    description: "Import and transcribe a completed call recording, save its transcript, and enqueue extraction.",
    schema: z.object({ callAttemptId: z.string() }),
  },
  {
    key: "extract_intent",
    name: "extract_attendance_details",
    description: "Extract employee intent, verification facts, and reported attendance time from the saved transcript.",
    schema: z.object({ callAttemptId: z.string() }),
  },
  {
    key: "evaluate_attendance",
    name: "evaluate_attendance_result",
    description: "Apply deterministic attendance rules to the extracted result and schedule the valid next action.",
    schema: z.object({ sessionId: z.string(), callAttemptId: z.string().optional() }),
  },
  {
    key: "evaluate_session",
    name: "evaluate_session_completion",
    description: "Reconcile both check-in and check-out stages and mark an exception when both are terminal but incomplete.",
    schema: z.object({ sessionId: z.string() }),
  },
  {
    key: "deliver_attendance",
    name: "deliver_confirmed_session",
    description: "Send a session to the configured platform only after both check-in and check-out are confirmed.",
    schema: z.object({ sessionId: z.string(), callAttemptId: z.string().optional() }),
  },
];

/**
 * Wrap each durable post-call worker operation as a typed LangChain tool.
 * The queue still chooses and orders operations; the model never chooses
 * retry timing, stage status, session completion, or external delivery.
 */
function createPostCallTools(operations) {
  const missing = operationSchemas.filter(({ key }) => typeof operations?.[key] !== "function");
  if (missing.length) throw new Error(`Post-call tool handlers missing: ${missing.map(({ key }) => key).join(", ")}`);

  const tools = operationSchemas.map(({ key, name, description, schema }) => tool(
    async (input) => {
      const result = await operations[key](input);
      return JSON.stringify({ ok: true, result: result ?? null });
    },
    { name, description, schema },
  ));
  const toolByKey = Object.fromEntries(operationSchemas.map(({ key }, index) => [key, tools[index]]));
  const handlers = Object.fromEntries(operationSchemas.map(({ key }, index) => [
    key,
    async (input) => { await tools[index].invoke(input); },
  ]));
  return { tools, handlers };
}

module.exports = { createPostCallTools };
