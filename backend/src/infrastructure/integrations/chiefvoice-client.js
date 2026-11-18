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
  now = () => new Date(),
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
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\bcv_(?:live|test)_[A-Za-z0-9._-]+/gi, "[redacted-key]")
      .replace(/\b(api[_ -]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]")
      .replace(/\s+/g, " ")
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

  async function getRecording(sessionId, { maxBytes = Number(process.env.MAX_RECORDING_DOWNLOAD_BYTES) || 100 * 1024 * 1024 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(timeoutMs, 30_000));
    try {
      const response = await fetchImpl(`${root}/v1/calls/${encodeURIComponent(sessionId)}/recording`, {
        method: "GET",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "audio/*, application/octet-stream" },
      });
      if (!response.ok) {
        const error = new Error(`ChiefVoice recording request returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (declaredLength > maxBytes) throw new Error("ChiefVoice recording exceeds configured download size limit");
      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            size += chunk.length;
            if (size > maxBytes) {
              await reader.cancel();
              throw new Error("ChiefVoice recording exceeds configured download size limit");
            }
            chunks.push(chunk);
          }
        } finally { reader.releaseLock(); }
        bytes = Buffer.concat(chunks, size);
      } else {
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (!bytes.length) throw new Error("ChiefVoice recording response was empty");
      if (bytes.length > maxBytes) throw new Error("ChiefVoice recording exceeds configured download size limit");
      return { buffer: bytes, contentType: response.headers?.get?.("content-type") || "application/octet-stream" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createOutboundCall({ to, from, sessionId, stage, callAttemptId, context, postCallContext = context, templateScenario = null }) {
    const callStartedAt = now();
    const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
    const currentLocalTime = new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).format(callStartedAt);
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
    const checkInOutputSchema = {
      type: "object",
      properties: {
        schema_version: { type: "string", enum: ["1.0"] },
        stage: { type: "string", enum: ["check_in"] },
        outcome: { type: "string", enum: ["arrived", "not_arrived", "unclear", "wrong_assignment"] },
        identity: {
          type: "object",
          properties: {
            caregiver_name_matches: { type: "boolean" },
            patient_name_matches: { type: "boolean" },
            patient_address_matches: { type: "boolean" },
          },
          required: ["caregiver_name_matches", "patient_name_matches", "patient_address_matches"],
          additionalProperties: false,
        },
        reported_at: {
          type: ["string", "null"],
          description: "Return the caregiver's explicitly stated actual arrival time as an ISO 8601 timestamp with the Asia/Kolkata offset. If the call did not ask for or receive an arrival time, return null; never copy scheduled_check_in_at.",
        },
        callback_at: {
          type: ["string", "null"],
          description: "For a requested follow-up, return the absolute ISO 8601 date-time with timezone offset, calculated from current_local_time and time_zone. For example, if the person says 5 minutes, add 5 minutes. If they give a clock time such as 10:10, return its next future occurrence in that time zone. Otherwise null.",
        },
        exception_code: { type: ["string", "null"] },
        summary: { type: "string" },
      },
      required: ["schema_version", "stage", "outcome", "identity", "reported_at", "callback_at", "exception_code", "summary"],
      additionalProperties: false,
    };
    const checkOutOutputSchema = {
      type: "object",
      properties: {
        schema_version: { type: "string", enum: ["1.0"] },
        stage: { type: "string", enum: ["check_out"] },
        outcome: { type: "string", enum: ["checked_out", "still_on_duty", "unclear", "wrong_assignment"] },
        reported_at: {
          type: ["string", "null"],
          description: "Return the caregiver's explicitly stated actual departure time as an ISO 8601 timestamp with the Asia/Kolkata offset. If the call did not ask for or receive a departure time, return null; never copy scheduled_check_out_at.",
        },
        callback_at: {
          type: ["string", "null"],
          description: "For a requested follow-up, return the absolute ISO 8601 date-time with timezone offset, calculated from current_local_time and time_zone. For example, if the person says 5 minutes, add 5 minutes. If they give a clock time such as 10:10, return its next future occurrence in that time zone. Otherwise null.",
        },
        exception_code: { type: ["string", "null"] },
        summary: { type: "string" },
      },
      required: ["schema_version", "stage", "outcome", "reported_at", "callback_at", "exception_code", "summary"],
      additionalProperties: false,
    };
    const outputSchema = scenario === "CARE_MANAGER_ESCALATION"
      ? undefined
      : stage === "check_out" ? checkOutOutputSchema : checkInOutputSchema;
    const payload = {
      channel: "phone",
      destination: to,
      caller_id: from,
      recording_allowed: process.env.CHIEFVOICE_RECORDING_ALLOWED === "true",
      live_agent: {
        template_id: liveTemplateId,
        context: {
          ...context,
          current_time_utc: callStartedAt.toISOString(),
          current_local_time: currentLocalTime,
          time_zone: timeZone,
          callback_time_instructions: "If a follow-up is requested, convert a relative delay such as 5 minutes into an absolute ISO 8601 date-time using current_local_time and time_zone. For a clock time such as 10:10, use its next future occurrence in time_zone. Return that absolute timestamp in callback_at; use null if no callback was requested or its time is unclear.",
          attendance_session_id: sessionId,
          call_attempt_id: callAttemptId,
          attendance_stage: stage,
        },
      },
      post_call: {
        template_id: postCallTemplateId,
        context: {
          ...postCallContext,
          current_time_utc: callStartedAt.toISOString(),
          current_local_time: currentLocalTime,
          time_zone: timeZone,
          callback_time_instructions: "If a follow-up is requested, convert a relative delay such as 5 minutes into an absolute ISO 8601 date-time using current_local_time and time_zone. For a clock time such as 10:10, use its next future occurrence in time_zone. Return that absolute timestamp in callback_at; use null if no callback was requested or its time is unclear.",
          attendance_session_id: sessionId,
          call_attempt_id: callAttemptId,
          attendance_stage: stage,
        },
        time_zone: timeZone,
        time_format: "%Y-%m-%dT%H:%M:%S%z",
        include_live_agent_context: true,
        tools: [{ type: "builtin", name: "time" }],
        ...(outputSchema ? { output_schema: outputSchema } : {}),
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

  return { request, createOutboundCall, getCallStatus, getPostCallResult, getRecording };
}

module.exports = { createChiefVoiceClient };
