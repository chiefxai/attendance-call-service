"use strict";

function createAttendanceBackendClient({
  endpoint = process.env.ATTENDANCE_BACKEND_URL,
  token = process.env.ATTENDANCE_BACKEND_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  async function sendAttendance(payload, { idempotencyKey } = {}) {
    if (!endpoint) throw new Error("ATTENDANCE_BACKEND_URL must be configured before delivering attendance");
    if (!idempotencyKey) throw new Error("An idempotency key is required for attendance delivery");
    if (typeof fetchImpl !== "function") throw new Error("Fetch API implementation is required");

    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.ATTENDANCE_BACKEND_TIMEOUT_MS || 15_000)),
    });
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; }
    catch { result = { message: text.slice(0, 1000) }; }
    if (!response.ok) throw new Error(`Attendance backend returned ${response.status}: ${result?.message || result?.error || response.statusText}`);
    return { status: response.status, body: result };
  }

  return { sendAttendance };
}

module.exports = { createAttendanceBackendClient };
