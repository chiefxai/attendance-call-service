"use strict";

module.exports = {
  // HTTP API and recording management
  ...require("./api/call-service-router"),
  ...require("./recording/manager"),

  // Attendance domain and async processing
  ...require("./domain/attendance/workflow"),
  ...require("./domain/repository-contract"),
  ...require("./workers/worker-runner"),

  // Infrastructure adapters
  ...require("./infrastructure/database/postgres-pool"),
  ...require("./infrastructure/database/postgres-repository"),
  ...require("./infrastructure/database/postgres-queue"),
  ...require("./infrastructure/storage/minio-recordings"),
  ...require("./infrastructure/integrations/attendance-backend-client"),
  ...require("./infrastructure/integrations/athulya-platform"),
  ...require("./infrastructure/integrations/athulya-attendance-client"),
  ...require("./infrastructure/integrations/chiefvoice-client"),
  ...require("./config"),
};
