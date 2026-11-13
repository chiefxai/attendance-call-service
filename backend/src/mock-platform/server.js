"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { localDateInTimeZone } = require("../infrastructure/integrations/athulya-platform");

const port = Math.max(1, Number(process.env.PORT) || 4000);
const apiKey = String(process.env.ATHULYA_MOCK_API_KEY || "mock-athulya-api-key");
const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
const submissions = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req, url) {
  const provided = String(req.headers["x-api-key"] || url.searchParams.get("api_key") || "");
  const expectedBuffer = Buffer.from(apiKey);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
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
    // Completed fixtures are imported for display and connection testing,
    // but cannot enqueue outbound Vobiz calls.
    schedule_status: "Completed",
    caregiver_schedule_status: "",
    caregiver_ids: "",
    caregiver_names: "",
    caregiver_phones: "",
    vendor_company: "ATHULYA",
  };
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
    const date = requestedFrom;
    const record = scheduleFor(date);
    const careManagerId = url.searchParams.get("care_manager_id");
    const branchId = url.searchParams.get("branch_id");
    const clientId = url.searchParams.get("client_id");
    const matches = (!careManagerId || careManagerId === record.care_manager_id)
      && (!branchId || branchId === record.branch)
      && (!clientId || clientId === record.patient_id);
    const data = matches && date <= requestedTo ? [record] : [];
    return json(res, 200, { status: "success", current_date: today, date_from: requestedFrom, date_to: requestedTo, total: data.length, data });
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
