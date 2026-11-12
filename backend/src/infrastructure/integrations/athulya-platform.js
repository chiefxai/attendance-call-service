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
  return Array.from({ length: count }, (_, index) => ({
    id: ids[index] == null ? null : String(ids[index]),
    name: names[index] == null ? null : String(names[index]),
    phone: phones[index] == null ? null : String(phones[index]),
    status: statuses[index] == null ? null : String(statuses[index]),
  })).filter((item) => item.id || item.name || item.phone);
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

function createAthulyaScheduleSyncHandler({ repository }) {
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
      await repository.finishAthulyaSyncRun(runId, { status: "succeeded", recordsReceived: records.length, recordsUpserted: upserted });
      console.info(`[athulya-sync] completed run=${runId} records=${records.length} upserted=${upserted}`);
    } catch (error) {
      await repository.finishAthulyaSyncRun(runId, { status: "failed", errorMessage: String(error.message || error).slice(0, 2000) });
      throw error;
    }
  };
}

module.exports = { DEFAULT_BASE_URL, encryptSecret, decryptSecret, validateBaseUrl, fetchAthulyaSchedules, sourceRecords, caregiverRows, localDateInTimeZone, latestDueAthulyaSyncSlot, createAthulyaScheduleSyncHandler };
