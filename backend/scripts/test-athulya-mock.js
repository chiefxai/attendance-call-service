"use strict";

require("dotenv/config");

const { encryptSecret, fetchAthulyaSchedules, localDateInTimeZone } = require("../src/infrastructure/integrations/athulya-platform");
const { createAthulyaAttendanceClient } = require("../src/infrastructure/integrations/athulya-attendance-client");

async function main() {
  const apiBaseUrl = String(process.env.ATHULYA_MOCK_API_BASE_URL || "http://127.0.0.1:4010/api");
  const apiKey = String(process.env.ATHULYA_MOCK_API_KEY || "mock-athulya-api-key");
  const scheduleDate = localDateInTimeZone(new Date(), process.env.APP_TIMEZONE || "Asia/Kolkata");
  const records = await fetchAthulyaSchedules({
    apiBaseUrl,
    apiKey,
    filters: { from_date: scheduleDate, to_date: scheduleDate },
  });
  if (!records.length) throw new Error(`Mock returned no schedules for ${scheduleDate}`);
  const scheduleId = String(records[0].source.schedule_id);
  console.info(`[mock-test] GET succeeded date=${scheduleDate} schedules=${records.length} scheduleId=${scheduleId}`);

  const repository = {
    async getAthulyaIntegration() {
      return { enabled: true, apiBaseUrl, encryptedApiKey: encryptSecret(apiKey) };
    },
  };
  const client = createAthulyaAttendanceClient({ repository });
  for (const type of ["check_in", "check_out"]) {
    const result = await client.sendAttendance({
      organizationId: "mock-test",
      scheduleId,
      type,
      timing: new Date(),
      idempotencyKey: `mock-test:${scheduleId}:${type}`,
    });
    console.info(`[mock-test] POST succeeded status=${result.status} scheduleId=${scheduleId} type=${result.payload.type} timing=${result.payload.timing}`);
  }

  const submissionsUrl = new URL("/mock/submissions", new URL(apiBaseUrl));
  submissionsUrl.searchParams.set("api_key", apiKey);
  const submissionsResponse = await fetch(submissionsUrl);
  if (!submissionsResponse.ok) throw new Error(`Could not read mock submissions: HTTP ${submissionsResponse.status}`);
  const submissions = await submissionsResponse.json();
  console.info(`[mock-test] mock server has received ${submissions.total} attendance event(s)`);
}

main().catch((error) => {
  console.error(`[mock-test] failed: ${error.message}`);
  process.exitCode = 1;
});
