"use strict";

/**
 * ChiefVoice owns telephony, the live agent and post-call extraction.
 * This service only schedules calls and consumes the resulting attendance data.
 */
function createChiefVoiceClient({
  baseUrl = process.env.CHIEFVOICE_URL || "https://chiefvoice.elvoryx.in",
  apiKey = process.env.CHIEFVOICE_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.CHIEFVOICE_TIMEOUT_MS) || 20_000,
} = {}) {
  if (!baseUrl) throw new Error("CHIEFVOICE_URL is required");
  if (!apiKey) throw new Error("CHIEFVOICE_API_KEY is required");
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible implementation is required");

  const root = baseUrl.replace(/\/+$/, "");

  async function request(path, { method = "GET", body, idempotencyKey } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { data = { message: raw.slice(0, 1000) }; }
      if (!response.ok) {
        const error = new Error(data.error?.message || data.message || `ChiefVoice API returned HTTP ${response.status}`);
        error.status = response.status;
        error.response = data;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createOutboundCall({ to, from, sessionId, stage, callAttemptId, context }) {
    const liveTemplateId = process.env.CHIEFVOICE_LIVE_TEMPLATE_ID;
    const postCallTemplateId = process.env.CHIEFVOICE_POST_CALL_TEMPLATE_ID;
    if (!liveTemplateId || !postCallTemplateId) {
      throw new Error("CHIEFVOICE_LIVE_TEMPLATE_ID and CHIEFVOICE_POST_CALL_TEMPLATE_ID must be configured");
    }
    const payload = {
      channel: "phone",
      destination: to,
      caller_id: from,
      recording_allowed: true,
      live_agent: {
        template_id: liveTemplateId,
        context: { ...context, attendance_session_id: sessionId, call_attempt_id: callAttemptId, attendance_stage: stage },
      },
      post_call: {
        template_id: postCallTemplateId,
        context: { ...context, attendance_session_id: sessionId, call_attempt_id: callAttemptId, attendance_stage: stage },
        time_zone: process.env.APP_TIMEZONE || "Asia/Kolkata",
        time_format: "%Y-%m-%dT%H:%M:%S%z",
        include_live_agent_context: true,
        tools: [{ type: "builtin", name: "time" }],
        output_schema: {
          type: "object",
          properties: {
            employeeIntent: { type: "string", enum: ["arrival_confirmed", "departure_confirmed", "will_arrive_later", "still_on_duty", "missed", "wrong_assignment", "unclear"] },
            employeeNameConfirmed: { type: "boolean" },
            patientNameConfirmed: { type: "boolean" },
            addressConfirmed: { type: "boolean" },
            employeeVerified: { type: "boolean" },
            clientVerified: { type: "boolean" },
            reachedPatient: { type: "boolean" },
            dutyComplete: { type: "boolean" },
            reportedArrivalTime: { type: ["string", "null"] },
            reportedDepartureTime: { type: ["string", "null"] },
            reportedArrivalTimeMentioned: { type: "boolean" },
            reportedDepartureTimeMentioned: { type: "boolean" },
            requestedCallbackAt: { type: ["string", "null"] },
            exceptionCode: { type: ["string", "null"] },
            summary: { type: "string" },
            arrival_status: { type: "string", enum: ["arrived", "not_arrived", "unclear"] },
            staff_name: { type: "string" },
            patient_name: { type: "string" },
            patient_address: { type: "string" },
            expected_arrival_time: { type: "string" },
            identity_verified: { type: "boolean" },
            follow_up_required: { type: "boolean" },
            conversation_summary: { type: "string" },
          },
          required: ["employeeIntent", "employeeNameConfirmed", "patientNameConfirmed", "addressConfirmed", "employeeVerified", "clientVerified", "reachedPatient", "dutyComplete", "reportedArrivalTime", "reportedDepartureTime", "reportedArrivalTimeMentioned", "reportedDepartureTimeMentioned", "requestedCallbackAt", "exceptionCode", "summary", "arrival_status", "staff_name", "patient_name", "patient_address", "expected_arrival_time", "identity_verified", "follow_up_required", "conversation_summary"],
          additionalProperties: false,
        },
      },
    };
    return request("/v1/calls/outbound", {
      method: "POST",
      body: payload,
      idempotencyKey: `attendance-${callAttemptId}`,
    });
  }

  return { request, createOutboundCall };
}

module.exports = { createChiefVoiceClient };
