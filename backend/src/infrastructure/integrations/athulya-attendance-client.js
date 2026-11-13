"use strict";

const { resolveAthulyaConnection } = require("./athulya-platform");

function formatTimingWithOffset(value, timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Attendance timing is invalid");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  const wallClockAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMinutes = Math.round((wallClockAsUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function createAthulyaAttendanceClient({ repository, fetchImpl = globalThis.fetch } = {}) {
  if (!repository?.getAthulyaIntegration) throw new Error("An Athulya integration repository is required");
  if (typeof fetchImpl !== "function") throw new Error("Fetch API implementation is required");

  async function sendAttendance({ organizationId, scheduleId, type, timing, idempotencyKey }) {
    if (!organizationId || !scheduleId) throw new Error("Athulya attendance requires an organization and schedule ID");
    if (!["check_in", "check_out"].includes(type)) throw new Error("Athulya attendance type must be check_in or check_out");
    const connection = await resolveAthulyaConnection(repository, organizationId);
    const apiKey = connection.apiKey;
    const baseUrl = connection.apiBaseUrl;
    const endpoint = new URL("check-in-out", `${baseUrl.replace(/\/+$/, "")}/`);
    const payload = { schedule_id: String(scheduleId), type, timing: formatTimingWithOffset(timing) };
    const timeoutMs = Math.max(1_000, Math.min(Number(process.env.ATHULYA_ATTENDANCE_TIMEOUT_MS) || 15_000, 120_000));
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; }
    catch { body = { message: text.slice(0, 1000) }; }
    if (!response.ok || body?.status !== "success") {
      const detail = body?.message || response.statusText || "Athulya attendance request failed";
      const error = new Error(`Athulya attendance API returned ${response.status}: ${String(detail).slice(0, 500)}`);
      error.statusCode = response.status;
      throw error;
    }
    return { status: response.status, body, payload };
  }

  return { sendAttendance };
}

module.exports = { createAthulyaAttendanceClient, formatTimingWithOffset };
