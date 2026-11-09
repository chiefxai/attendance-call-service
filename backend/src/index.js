"use strict";

module.exports = {
  // HTTP API and realtime call transport
  ...require("./api/call-service-router"),
  ...require("./realtime/vobiz-live-runtime"),

  // Attendance domain and async processing
  ...require("./domain/attendance/workflow"),
  ...require("./domain/repository-contract"),
  ...require("./workers/worker-runner"),

  // Infrastructure adapters
  ...require("./infrastructure/database/postgres-pool"),
  ...require("./infrastructure/database/postgres-repository"),
  ...require("./infrastructure/database/postgres-queue"),
  ...require("./infrastructure/storage/minio-recordings"),
  ...require("./infrastructure/telephony/vobiz-client"),
  ...require("./infrastructure/telephony/vobiz-signature"),
  ...require("./agents/vertex-agent"),
  ...require("./config"),
};
