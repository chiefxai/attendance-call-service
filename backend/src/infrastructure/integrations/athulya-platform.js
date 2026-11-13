"use strict";

const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://homecare.athulyaliving.net/api";

function encryptionKey() {
  const raw = String(process.env.ATHULYA_CREDENTIALS_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("ATHULYA_CREDENTIALS_ENCRYPTION_KEY must be a 32-byte hexadecimal key");
  return Buffer.from(raw, "hex");
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

function decryptSecret(value) {
  if (!value) return "";
  const [version, ivHex, tagHex, dataHex] = String(value).split(":");
  if (version !== "v1" || !ivHex || !tagHex || !dataHex) throw new Error("Stored Athulya API key has an unsupported encrypted format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

function validateBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BASE_URL));
  if (parsed.protocol !== "https:" || !(parsed.hostname === "athulyaliving.net" || parsed.hostname.endsWith(".athulyaliving.net"))) {
    throw new Error("Athulya API Base URL must use HTTPS on an athulyaliving.net host");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  if (typeof value !== "string") return [value];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* Some source responses use comma separated values. */ }
  return value.split(/[;,|]/).map((item) => item.trim()).filter(Boolean);
}

function caregiverRows(record) {
  const ids = listValue(record.caregiver_ids);
  const names = listValue(record.caregiver_names);
  const phones = listValue(record.caregiver_phones);
  const statuses = listValue(record.caregiver_schedule_status);
  const count = Math.max(ids.length, names.length, phones.length, statuses.length);
  const unique = new Map();
  Array.from({ length: count }, (_, index) => ({
    id: ids[index] == null ? null : String(ids[index]).trim() || null,
    name: names[index] == null ? null : String(names[index]).trim() || null,
    phone: phones[index] == null ? null : String(phones[index]).trim() || null,
    status: statuses[index] == null ? null : String(statuses[index]).trim() || null,
  })).filter((item) => item.id || item.name || item.phone).forEach((item) => {
    // Use stable Athulya IDs first. Phone is a fallback when the schedule omits
    // caregiver IDs, so one person is not repeated in the same schedule row.
    const phoneKey = item.phone?.replace(/\D/g, "");
    const key = item.id ? `id:${item.id}` : phoneKey ? `phone:${phoneKey}` : null;
    if (!key) { unique.set(`row:${unique.size}`, item); return; }
    const previous = unique.get(key);
    unique.set(key, previous ? {
      id: previous.id || item.id,
      name: previous.name || item.name,
      phone: previous.phone || item.phone,
      status: previous.status || item.status,
    } : item);
  });
  return [...unique.values()];
}

function sourceRecords(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.clients ?? payload?.records;
  if (!Array.isArray(rows)) throw new Error("Athulya response did not contain a schedule array");
  if (rows.length > 5000) throw new Error("Athulya returned more than the documented 5,000-record limit");
  return rows.filter((item) => item && typeof item === "object").map((source) => ({
    source,
    scheduleDate: dateOnly(source.schedule_date ?? source.current_date),
    serviceFromDate: dateOnly(source.service_from_date),
    serviceToDate: dateOnly(source.service_to_date),
    caregivers: caregiverRows(source),
  }));
}

function dateOnly(value) {
  if (value == null || value === "") return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function zonedParts(date, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return values;
}

function localScheduleDateTimeToUtc(dateValue, timeValue, timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata") {
  const dateText = dateOnly(dateValue);
  if (!dateText || timeValue == null || timeValue === "") return null;
  const timeText = String(timeValue).trim();
  const zonedDateTime = timeText.match(/^(\\d{4}-\\d{2}-\\d{2})[T ](\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?)((?:Z|[+-]\\d{2}:?\\d{2}))$/i);
  if (zonedDateTime) {
    const direct = new Date(timeText);
    return Number.isFinite(direct.getTime()) ? direct.toISOString() : null;
  }
  const match = timeText.match(/^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = String(match[4] || "").toUpperCase();
  if (minute > 59 || second > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem === "PM" ? 12 : 0);
  } else if (hour > 23) return null;
  const [year, month, day] = dateText.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = target;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = zonedParts(new Date(candidate), timeZone);
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second || 0));
      const adjustment = target - represented;
      candidate += adjustment;
      if (adjustment === 0) break;
    }
    const resolved = new Date(candidate);
    const parts = zonedParts(resolved, timeZone);
    if (Number(parts.year) !== year || Number(parts.month) !== month || Number(parts.day) !== day
      || Number(parts.hour) !== hour || Number(parts.minute) !== minute) return null;
    return resolved.toISOString();
  } catch { return null; }
}

function localDateInTimeZone(date = new Date(), timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata") {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localSlotToDate(year, month, day, hour, timeZone) {
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), 0);
    candidate += target - represented;
  }
  return new Date(candidate);
}

function latestDueAthulyaSyncSlot(now = new Date(), { timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata", enabledAt = null } = {}) {
  const local = zonedParts(now, timeZone);
  const localMinute = Number(local.hour) * 60 + Number(local.minute);
  const hour = localMinute >= 12 * 60 ? 12 : 0;
  const at = localSlotToDate(local.year, local.month, local.day, hour, timeZone);
  if (at > now || (enabledAt && new Date(enabledAt) > at)) return null;
  return { key: `${local.year}-${local.month}-${local.day}T${String(hour).padStart(2, "0")}:00`, at };
}

async function fetchAthulyaSchedules({ apiBaseUrl, apiKey, filters = {}, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("Athulya API key is not configured");
  const base = validateBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/caremanager/clients`);
  for (const key of ["from_date", "to_date", "care_manager_id", "branch_id", "client_id"]) {
    if (filters[key] != null && String(filters[key]).trim()) url.searchParams.set(key, String(filters[key]).trim());
  }
  if (filters.from_date && filters.to_date && filters.to_date < filters.from_date) throw new Error("to_date must be the same as or later than from_date");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey, Accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Athulya returned HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("Athulya response was not valid JSON"); }
    const records = sourceRecords(payload);
    const fromDate = filters.from_date ? String(filters.from_date) : null;
    const toDate = filters.to_date ? String(filters.to_date) : null;
    return records.filter(({ scheduleDate }) => scheduleDate
      && (!fromDate || scheduleDate >= fromDate)
      && (!toDate || scheduleDate <= toDate));
  } finally { clearTimeout(timeout); }
}

function createAthulyaScheduleSyncHandler({ repository, queue }) {
  return async ({ runId, organizationId, filters = {} }) => {
    try {
      const settings = await repository.getAthulyaIntegration(organizationId);
      if (!settings.enabled) throw new Error("Athulya integration is disabled");
      const records = await fetchAthulyaSchedules({
        apiBaseUrl: settings.apiBaseUrl,
        apiKey: decryptSecret(settings.encryptedApiKey),
        filters,
      });
      const upserted = await repository.upsertAthulyaSchedules(organizationId, records);
      const callSettings = await repository.getOrganizationCallSettings(organizationId);
      const fromNumber = callSettings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER || "";
      const activeAgents = (await repository.listAgents(organizationId)).filter((agent) => agent.active);
      let scheduledCalls = 0;
      let skippedSchedules = 0;
      for (const item of records) {
        const source = item.source || {};
        const status = String(source.schedule_status || "").trim().toLowerCase().replace(/[\\s-]+/g, "_");
        const scheduleId = String(source.schedule_id || "").trim();
        const schedulePk = String(source.schedule_pk || "").trim();
        if (!scheduleId) { skippedSchedules += 1; continue; }
        if (["cancelled", "canceled", "completed", "complete"].includes(status)) {
          await repository.cancelActiveAthulyaAttendanceSessions({ organizationId, scheduleId, schedulePk });
          continue;
        }
        if (!["pending", "scheduled", "active", "confirmed", "approved", "assigned", "in_progress"].includes(status)) {
          skippedSchedules += 1;
          console.warn(`[athulya-sync] not scheduling calls for unrecognized schedule status schedule=${scheduleId} status=${status || "empty"}`);
          continue;
        }
        const scheduledStartAt = localScheduleDateTimeToUtc(item.scheduleDate, source.start_time);
        const scheduledEndAt = localScheduleDateTimeToUtc(item.scheduleDate, source.end_time);
        if (!scheduledStartAt || !scheduledEndAt || new Date(scheduledEndAt) <= new Date(scheduledStartAt)) {
          skippedSchedules += 1;
          console.warn(`[athulya-sync] invalid schedule date or time; calls skipped schedule=${scheduleId}`);
          continue;
        }
        if (!fromNumber || activeAgents.length === 0) {
          skippedSchedules += 1;
          console.warn(`[athulya-sync] caller ID or active attendance agent missing; calls skipped schedule=${scheduleId}`);
          continue;
        }
        const patientId = String(source.patient_id || "").trim();
        const patient = (patientId && await repository.getActivePatientDirectoryRecord(organizationId, patientId))
          || { id: patientId, name: String(source.client_name || "").trim(), phoneNumber: "", address: "", language: "ta",
            patientUhid: String(source.patient_uhid || "").trim(), branch: String(source.branch || "").trim() };
        const caregivers = Array.isArray(item.caregivers) ? item.caregivers : [];
        let scheduledForRecord = 0;
        for (const caregiver of caregivers) {
          const caregiverId = String(caregiver.id || "").trim();
          if (!caregiverId) continue;
          const staff = await repository.getActiveStaffDirectoryRecord(organizationId, caregiverId);
          if (!staff?.phoneNumber) continue;
          const language = String(staff.language || "ta").trim().toLowerCase();
          const languagePrefix = language.slice(0, 2);
          const agent = activeAgents.find((candidate) => String(candidate.language || "").trim().toLowerCase().startsWith(languagePrefix))
            || activeAgents[0];
          const result = await repository.createAthulyaAttendanceSession({
            organizationId, scheduleId, schedulePk, caregiverId, staff, patient, agent, fromNumber,
            scheduledStartAt, scheduledEndAt, language, sourceStatus: status,
            metadata: {
              careManagerId: String(source.care_manager_id || "").trim(),
              branch: String(source.branch || "").trim(),
              serviceName: String(source.service_name || "").trim(),
              vendorCompany: String(source.vendor_company || "ATHULYA").trim() || "ATHULYA",
            },
          });
          if (!result.session) {
            skippedSchedules += 1;
            console.warn(`[athulya-sync] schedule changed after calls started; manual review required schedule=${scheduleId} caregiver=${caregiverId}`);
            continue;
          }
          for (const stage of ["check_in", "check_out"]) {
            const stageTask = stage === "check_in" ? result.session.checkInTask : result.session.checkOutTask;
            const runAt = new Date(stage === "check_in" ? result.session.scheduledStartAt : result.session.scheduledEndAt);
            const job = await queue.enqueue("place_call", { sessionId: result.session.id, taskId: stageTask?.id, stage, attemptNumber: 1 }, {
              idempotencyKey: `call:${result.session.id}:${stage}:1`, runAt,
            });
            if (job?.status === "queued" || job?.status === "running") scheduledCalls += 1;
          }
          scheduledForRecord += 1;
        }
        if (scheduledForRecord === 0) {
          skippedSchedules += 1;
          console.warn(`[athulya-sync] no active caregiver with a registered phone; calls skipped schedule=${scheduleId}`);
        }
      }
      await repository.finishAthulyaSyncRun(runId, { status: "succeeded", recordsReceived: records.length, recordsUpserted: upserted });
      console.info(`[athulya-sync] completed run=${runId} records=${records.length} upserted=${upserted} callJobsQueued=${scheduledCalls} skipped=${skippedSchedules}`);
    } catch (error) {
      await repository.finishAthulyaSyncRun(runId, { status: "failed", errorMessage: String(error.message || error).slice(0, 2000) });
      throw error;
    }
  };
}

module.exports = { DEFAULT_BASE_URL, encryptSecret, decryptSecret, validateBaseUrl, fetchAthulyaSchedules, sourceRecords, caregiverRows, localScheduleDateTimeToUtc, localDateInTimeZone, latestDueAthulyaSyncSlot, createAthulyaScheduleSyncHandler };
