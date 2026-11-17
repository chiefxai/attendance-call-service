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

  function redactProviderText(value, requestBody) {
    let text = String(value || "").slice(0, 240);
    const privateValues = new Set();
    const collectPrivateValues = (value) => {
      if (typeof value === "string" && value.trim().length >= 3) privateValues.add(value.trim());
      else if (Array.isArray(value)) value.forEach(collectPrivateValues);
      else if (value && typeof value === "object") Object.values(value).forEach(collectPrivateValues);
    };
    collectPrivateValues(requestBody);
    for (const privateValue of [...privateValues].sort((a, b) => b.length - a.length)) {
      text = text.split(privateValue).join("[redacted]");
    }
    return text
      .replace(/\\bBearer\\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\\bcv_(?:live|test)_[A-Za-z0-9._-]+/gi, "[redacted-key]")
      .replace(/\\b(api[_ -]?key|token|secret)\\s*[:=]\\s*[^\\s,;]+/gi, "$1=[redacted]")
      .replace(/\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b/gi, "[redacted-email]")
      .replace(/\\+?\\d[\\d\\s().-]{7,}\\d/g, "[redacted-phone]")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function safeValidationSummary(data, requestBody) {
    const entries = Array.isArray(data?.detail) ? data.detail
      : Array.isArray(data?.errors) ? data.errors
        : Array.isArray(data?.issues) ? data.issues : [];
    const summary = entries.slice(0, 5).map((entry) => {
      const pathParts = Array.isArray(entry?.loc) ? entry.loc : Array.isArray(entry?.path) ? entry.path : [];
      const path = pathParts.slice(0, 8)
        .map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48))
        .filter(Boolean)
        .join(".");
      const code = String(entry?.type || entry?.code || "validation_error")
        .replace(/[^A-Za-z0-9_.-]/g, "")
        .slice(0, 64);
      const message = redactProviderText(entry?.msg || entry?.message || "", requestBody);
      return [path || "request", code, message].filter(Boolean).join(": ");
    }).filter(Boolean).join("; ");
    if (summary) return summary;
    const detail = typeof data?.detail === "string" ? data.detail
      : typeof data?.message === "string" ? data.message : "";
    return redactProviderText(detail, requestBody);
  }

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
        // Keep only allowlisted validation metadata. Never persist the response
        // body or provider-supplied input values, which may contain call data.
        const details = response.status === 422 ? safeValidationSummary(data, body) : "";
        const error = new Error(`ChiefVoice API returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createOutboundCall({ to, from, sessionId, stage, callAttemptId, context, templateScenario = null }) {
    const scenario = String(templateScenario || "").trim().toUpperCase();
    const scenarioPrefix = scenario ? `CHIEFVOICE_TEMPLATE_${scenario}` : null;
    const liveTemplateId = scenarioPrefix
      ? process.env[`${scenarioPrefix}_LIVE_ID`]
      : process.env.CHIEFVOICE_LIVE_TEMPLATE_ID;
    const postCallTemplateId = scenarioPrefix
      ? process.env[`${scenarioPrefix}_POST_CALL_ID`]
      : process.env.CHIEFVOICE_POST_CALL_TEMPLATE_ID;
    if (!liveTemplateId || !postCallTemplateId) {
      const missing = [
        !liveTemplateId ? `${scenarioPrefix || "CHIEFVOICE_TEMPLATE_<SCENARIO>"}_LIVE_ID` : null,
        !postCallTemplateId ? `${scenarioPrefix || "CHIEFVOICE_TEMPLATE_<SCENARIO>"}_POST_CALL_ID` : null,
      ].filter(Boolean);
      throw new Error(`${missing.join(" and ")} must be configured`);
    }
    const payload = {
      channel: "phone",
      destination: to,
      caller_id: from,
      recording_allowed: process.env.CHIEFVOICE_RECORDING_ALLOWED === "true",
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

  function getCallStatus(sessionId) {
    return request(`/v1/calls/${encodeURIComponent(sessionId)}`);
  }

  function getPostCallResult(sessionId) {
    return request(`/v1/calls/${encodeURIComponent(sessionId)}/post-call`);
  }

  return { request, createOutboundCall, getCallStatus, getPostCallResult };
}

module.exports = { createChiefVoiceClient };
