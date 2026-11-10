"use strict";

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

// Exact patient-number lookup only: no staff search and no directory listing.
function createPatientContactTool(repository, organizationId) {
  if (!repository?.findPatientContactByPhone || !organizationId) throw new Error("Patient contact tool requires an organization-scoped repository");
  return tool(async ({ phoneNumber }) => JSON.stringify(await repository.findPatientContactByPhone(organizationId, phoneNumber)), {
    name: "find_patient_contact_by_phone",
    description: "Match an incoming caller to one registered patient using their exact phone number. Returns patient contact fields only; never staff contacts or a directory.",
    schema: z.object({ phoneNumber: z.string().min(7).max(32) }),
  });
}

module.exports = { createPatientContactTool };
