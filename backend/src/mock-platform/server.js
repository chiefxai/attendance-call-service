"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { localDateInTimeZone, localScheduleDateTimeToUtc } = require("../infrastructure/integrations/athulya-platform");

const port = Math.max(1, Number(process.env.PORT) || 4000);
const apiKey = String(process.env.ATHULYA_MOCK_API_KEY || "");
const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
const submissions = new Map();
const schedules = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req, url) {
  const provided = String(req.headers["x-api-key"] || url.searchParams.get("api_key") || "");
  const expectedBuffer = Buffer.from(apiKey);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length > 0 && expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function scheduleFor(date) {
  return {
    schedule_id: `MOCK-${date.replaceAll("-", "")}-001`,
    schedule_pk: `MOCK-PK-${date.replaceAll("-", "")}-001`,
    schedule_date: date,
    start_time: "10:00:00",
    end_time: "11:00:00",
    current_date: date,
    client_name: "Mock Patient",
    patient_id: "MOCK-PATIENT-001",
    patient_uhid: "MOCK-UHID-001",
    patient_address: "1 Test Street, Chennai, Tamil Nadu, India",
    latitude: "N/A",
    longitude: "N/A",
    care_manager_id: "MOCK-CM-001",
    care_manager_name: "Mock Care Manager",
    care_manager_phone: "+919999900001",
    service_name: "Mock Home Care Visit",
    service_from_date: `${date}T00:00:00.000Z`,
    service_to_date: `${date}T00:00:00.000Z`,
    branch: "Mock Chennai Branch",
    care_plan: "Mock test data",
    active_service_status: "long_term",
    // Keep the fixture completed so a mock sync imports the caregiver and schedule
    // without queuing real outbound calls to the test phone number.
    schedule_status: "Completed",
    caregiver_schedule_status: "Assigned",
    caregiver_ids: "MOCK-CAREGIVER-001",
    caregiver_names: "Mock Caregiver",
    caregiver_phones: "+916384670687",
    vendor_company: "ATHULYA",
  };
}

const today = localDateInTimeZone(new Date(), timeZone);
schedules.set(scheduleFor(today).schedule_id, scheduleFor(today));

function normalizeSchedule(input, existing = {}) {
  const date = String(input.schedule_date || existing.schedule_date || today).slice(0, 10);
  const dateCheck = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error("schedule_date must be a valid date in YYYY-MM-DD format"), { status: 400 });
  }
  const value = { ...scheduleFor(date), ...existing, ...input, schedule_date: date };
  value.schedule_status = String(input.schedule_status || existing.schedule_status || "Scheduled");
  value.schedule_id = String(input.schedule_id || existing.schedule_id || `MOCK-${date.replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8)}`);
  value.schedule_pk = String(input.schedule_pk || existing.schedule_pk || `MOCK-PK-${value.schedule_id}`);
  for (const field of ["client_name", "patient_id", "caregiver_ids", "caregiver_names", "caregiver_phones"]) {
    value[field] = String(value[field] ?? "").trim();
  }
  if (!value.client_name || !value.patient_id) throw Object.assign(new Error("client_name and patient_id are required"), { status: 400 });
  const startAt = localScheduleDateTimeToUtc(date, value.start_time, timeZone);
  const endAt = localScheduleDateTimeToUtc(date, value.end_time, timeZone);
  if (!startAt || !endAt) throw Object.assign(new Error("start_time and end_time must be valid times (HH:mm or HH:mm:ss)"), { status: 400 });
  if (Date.parse(startAt) >= Date.parse(endAt)) throw Object.assign(new Error("start_time must be earlier than end_time"), { status: 400 });
  if (Date.parse(startAt) <= Date.now()) throw Object.assign(new Error("Schedule start must be in the future; choose a future date or time"), { status: 400 });
  return value;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { status: "ok", service: "mock-athulya" });
  if (!authorized(req, url)) return json(res, 401, { status: "error", message: "Invalid mock API key" });

  if (req.method === "GET" && url.pathname === "/api/caremanager/clients") {
    const today = localDateInTimeZone(new Date(), timeZone);
    const requestedFrom = url.searchParams.get("from_date") || today;
    const requestedTo = url.searchParams.get("to_date") || requestedFrom;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(requestedTo) || requestedFrom > requestedTo) {
      return json(res, 400, { status: "error", message: "Use valid from_date and to_date values (YYYY-MM-DD)" });
    }
    const careManagerId = url.searchParams.get("care_manager_id");
    const branchId = url.searchParams.get("branch_id");
    const clientId = url.searchParams.get("client_id");
    const data = [...schedules.values()].filter((record) => record.schedule_date >= requestedFrom && record.schedule_date <= requestedTo
      && (!careManagerId || careManagerId === record.care_manager_id)
      && (!branchId || branchId === record.branch)
      && (!clientId || clientId === record.patient_id));
    return json(res, 200, { status: "success", current_date: today, date_from: requestedFrom, date_to: requestedTo, total: data.length, data });
  }

  if (url.pathname === "/mock/schedules" && req.method === "GET") {
    return json(res, 200, { total: schedules.size, data: [...schedules.values()].sort((a, b) => a.schedule_date.localeCompare(b.schedule_date)) });
  }
  if (url.pathname === "/mock/schedules" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const record = normalizeSchedule(body);
      if (schedules.has(record.schedule_id)) return json(res, 409, { status: "error", message: "schedule_id already exists" });
      schedules.set(record.schedule_id, record);
      return json(res, 201, { status: "success", data: record });
    } catch (error) { return json(res, error.status || 400, { status: "error", message: error.message }); }
  }
  const scheduleMatch = url.pathname.startsWith("/mock/schedules/") ? [url.pathname, url.pathname.slice("/mock/schedules/".length)] : null;
  if (scheduleMatch && req.method === "PUT") {
    try {
      const id = decodeURIComponent(scheduleMatch[1]);
      const existing = schedules.get(id);
      if (!existing) return json(res, 404, { status: "error", message: "Schedule not found" });
      const record = normalizeSchedule(await readJson(req), existing);
      record.schedule_id = id;
      schedules.set(id, record);
      return json(res, 200, { status: "success", data: record });
    } catch (error) { return json(res, error.status || 400, { status: "error", message: error.message }); }
  }
  if (scheduleMatch && req.method === "DELETE") {
    const id = decodeURIComponent(scheduleMatch[1]);
    if (!schedules.delete(id)) return json(res, 404, { status: "error", message: "Schedule not found" });
    return json(res, 200, { status: "success", message: "Schedule deleted" });
  }

  if (req.method === "POST" && url.pathname === "/api/check-in-out") {
    try {
      const body = await readJson(req);
      const scheduleId = String(body.schedule_id || "").trim();
      const type = String(body.type || "").trim();
      const timing = String(body.timing || "").trim();
      if (!scheduleId || !["check_in", "check_out"].includes(type) || !/[+-]\d{2}:\d{2}$/.test(timing) || !Number.isFinite(Date.parse(timing))) {
        return json(res, 400, { status: "error", message: "Expected schedule_id, type (check_in/check_out), and an ISO-8601 timing with UTC offset" });
      }
      const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
      if (idempotencyKey && submissions.has(idempotencyKey)) {
        return json(res, 200, { status: "success", message: "Duplicate event accepted idempotently", data: submissions.get(idempotencyKey) });
      }
      const submission = { id: crypto.randomUUID(), schedule_id: scheduleId, type, timing, received_at: new Date().toISOString() };
      const key = idempotencyKey || submission.id;
      submissions.set(key, submission);
      console.info(`[mock-athulya] received attendance event schedule=${scheduleId} type=${type} timing=${timing}`);
      return json(res, 200, { status: "success", message: "Attendance event received", data: submission });
    } catch (error) {
      return json(res, error.status || 400, { status: "error", message: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/mock/submissions") {
    return json(res, 200, { total: submissions.size, data: [...submissions.values()] });
  }
  if (req.method === "DELETE" && url.pathname === "/mock/submissions") {
    submissions.clear();
    return json(res, 200, { status: "success", message: "Mock submissions cleared" });
  }
  return json(res, 404, { status: "error", message: "Mock route not found" });
});

server.listen(port, "0.0.0.0", () => console.info(`[mock-athulya] listening on 0.0.0.0:${port}`));
