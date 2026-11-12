"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptSecret, decryptSecret, validateBaseUrl, caregiverRows, sourceRecords, fetchAthulyaSchedules } = require("../src/infrastructure/integrations/athulya-platform");

process.env.ATHULYA_CREDENTIALS_ENCRYPTION_KEY = "a".repeat(64);

test("Athulya API credentials encrypt and decrypt with authenticated ciphertext", () => {
  const encrypted = encryptSecret("a-secret-api-key");
  assert.notEqual(encrypted, "a-secret-api-key");
  assert.equal(decryptSecret(encrypted), "a-secret-api-key");
  assert.throws(() => decryptSecret(encrypted.replace(/.$/, encrypted.endsWith("0") ? "1" : "0")));
});

test("Athulya base URLs are restricted to HTTPS Athulya hosts", () => {
  assert.equal(validateBaseUrl("https://homecare.athulyaliving.net/api/"), "https://homecare.athulyaliving.net/api");
  assert.throws(() => validateBaseUrl("http://homecare.athulyaliving.net/api"));
  assert.throws(() => validateBaseUrl("https://athulyaliving.net.attacker.example/api"));
});

test("schedule mapping keeps date-only values and aligns caregiver identifiers", () => {
  const rows = sourceRecords({ data: [{
    schedule_id: 12, schedule_pk: 99, schedule_date: "2026-11-12T00:00:00Z", current_date: "2026-11-11",
    caregiver_ids: "[\"c1\",\"c2\"]", caregiver_names: "Asha, Bala", caregiver_phones: ["+911111111111", "+912222222222"],
  }] });
  assert.equal(rows[0].scheduleDate, "2026-11-12");
  assert.deepEqual(rows[0].caregivers.map(({ id, name }) => ({ id, name })), [{ id: "c1", name: "Asha" }, { id: "c2", name: "Bala" }]);
});

test("schedule fetch uses x-api-key and combines documented filters in query parameters", async () => {
  let requestedUrl;
  let requestedHeaders;
  const records = await fetchAthulyaSchedules({
    apiBaseUrl: "https://homecare.athulyaliving.net/api", apiKey: "secret",
    filters: { from_date: "2026-11-01", to_date: "2026-11-30", branch_id: "b1", client_id: "p1" },
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedHeaders = options.headers;
      return { ok: true, text: async () => JSON.stringify({ clients: [{ schedule_id: "s1" }] }) };
    },
  });
  assert.equal(requestedUrl.searchParams.get("from_date"), "2026-11-01");
  assert.equal(requestedUrl.searchParams.get("to_date"), "2026-11-30");
  assert.equal(requestedUrl.searchParams.get("branch_id"), "b1");
  assert.equal(requestedUrl.searchParams.get("client_id"), "p1");
  assert.equal(requestedUrl.searchParams.has("x-api-key"), false);
  assert.equal(requestedHeaders["x-api-key"], "secret");
  assert.equal(records.length, 1);
});

test("schedule fetch rejects invalid date ranges and unsupported response envelopes", async () => {
  await assert.rejects(() => fetchAthulyaSchedules({ apiBaseUrl: "https://homecare.athulyaliving.net/api", apiKey: "x", filters: { from_date: "2026-12-01", to_date: "2026-11-30" } }));
  await assert.rejects(() => fetchAthulyaSchedules({
    apiBaseUrl: "https://homecare.athulyaliving.net/api", apiKey: "x",
    fetchImpl: async () => ({ ok: true, text: async () => "{}" }),
  }), /schedule array/);
});

test("caregiver fields accept arrays and common delimited source strings", () => {
  assert.deepEqual(caregiverRows({ caregiver_ids: "c1|c2", caregiver_names: ["Asha", "Bala"], caregiver_phones: "111;222" }), [
    { id: "c1", name: "Asha", phone: "111", status: null },
    { id: "c2", name: "Bala", phone: "222", status: null },
  ]);
});
