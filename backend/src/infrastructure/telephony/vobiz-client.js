"use strict";

function createVobizClient({
  authId = process.env.VOBIZ_AUTH_ID,
  authToken = process.env.VOBIZ_AUTH_TOKEN,
  baseUrl = process.env.VOBIZ_API_BASE_URL || "https://api.vobiz.ai/api/v1",
  answerUrl = process.env.VOBIZ_ANSWER_URL,
  hangupUrl = process.env.VOBIZ_HANGUP_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  async function createCall({ to, from, agentId, campaignId, contactId, sessionId, stage, callAttemptId, appointmentCallId }) {
    if (!authId || !authToken) throw new Error("VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN must be configured");
    if (!answerUrl) throw new Error("VOBIZ_ANSWER_URL must be configured");
    if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required");

    const answer = new URL(answerUrl);
    answer.searchParams.set("agentId", agentId);
    if (campaignId) answer.searchParams.set("campaignId", campaignId);
    if (contactId) answer.searchParams.set("contactId", contactId);
    if (sessionId) answer.searchParams.set("sessionId", sessionId);
    if (stage) answer.searchParams.set("stage", stage);
    if (callAttemptId) answer.searchParams.set("callAttemptId", callAttemptId);
    if (appointmentCallId) answer.searchParams.set("appointmentCallId", appointmentCallId);
    const endpoint = `${baseUrl.replace(/\/$/, "")}/Account/${encodeURIComponent(authId)}/Call/`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "X-Auth-ID": authId,
        "X-Auth-Token": authToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        answer_url: answer.toString(),
        answer_method: "POST",
        ...(hangupUrl ? { hangup_url: hangupUrl, hangup_method: "POST" } : {}),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `Vobiz request failed (${response.status})`);
      error.status = response.status >= 500 ? 502 : 400;
      throw error;
    }
    return payload;
  }

  async function hangupCall(callId) {
    if (!authId || !authToken) throw new Error("VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN must be configured");
    const endpoint = `${baseUrl.replace(/\/$/, "")}/Account/${encodeURIComponent(authId)}/Call/${encodeURIComponent(callId)}/`;
    const response = await fetchImpl(endpoint, {
      method: "DELETE",
      headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Vobiz hangup failed (${response.status})`);
    }
    return true;
  }

  return { createCall, hangupCall };
}

module.exports = { createVobizClient };
