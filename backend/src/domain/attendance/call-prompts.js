"use strict";

const CALL_PROMPT_SCENARIOS = [
  { id: "CHECK_IN", label: "Check-in", live: "Call the assigned caregiver about the scheduled check-in. Verify the caregiver, patient, and address against the assignment before confirming arrival. Ask whether the caregiver has reached the patient's home. If they have, capture the actual arrival time; if not, ask for the expected arrival time and arrange a follow-up.", post: "Extract the check-in outcome and only the actual arrival time explicitly reported by the caregiver. Match identity using the assignment context and the required output schema. Do not copy the scheduled time into the actual time." },
  { id: "CHECK_OUT", label: "Check-out", live: "Call the assigned caregiver about the scheduled check-out. Confirm whether the duty is complete, and ask for the actual departure time. If the caregiver is still on duty or requests a later call, capture the follow-up timing.", post: "Extract whether the caregiver checked out, remains on duty, or could not be reached. Include only an explicitly reported actual departure time, and follow the required output schema." },
  { id: "CARE_MANAGER_ESCALATION", label: "Care manager escalation", live: "Briefly notify the care manager that the assigned caregiver did not answer the configured attendance call attempts. Share only the alert details provided in context and ask the manager to contact operations. Do not invent details or imply the caregiver's attendance status is known.", post: "Record whether the care manager was reached and whether the escalation message was delivered. Summarize the interaction factually using the required output schema." },
  { id: "CHECK_IN_RETRY", label: "Check-in retry", live: "This is a retry for the scheduled check-in. Briefly explain that you are following up about the caregiver's arrival. Verify the assigned caregiver and patient using the provided context, ask whether the caregiver has arrived, and collect the actual arrival time or an expected arrival time.", post: "Extract the check-in outcome from this retry. Use only what was explicitly reported, distinguish actual arrival time from scheduled time, and follow the required output schema." },
  { id: "CHECK_OUT_RETRY", label: "Check-out retry", live: "This is a retry for the scheduled check-out. Briefly explain that you are following up about the caregiver's duty. Ask whether the duty is complete and collect the actual departure time, or a callback time if the caregiver is still on duty.", post: "Extract the check-out outcome from this retry. Use only an explicitly reported actual departure time and follow the required output schema." },
  { id: "CHECK_IN_FOLLOW_UP", label: "Check-in follow-up", live: "This is a follow-up about the caregiver's check-in or expected arrival. Respect any callback time in the context. Ask whether the caregiver has now reached the patient's home and collect the actual arrival time, or ask for an updated expected arrival time.", post: "Extract the latest check-in outcome and explicitly reported arrival or callback time. Do not treat the scheduled time as an actual time; follow the required output schema." },
  { id: "CHECK_OUT_FOLLOW_UP", label: "Check-out follow-up", live: "This is a follow-up about the caregiver's check-out. Respect any callback time in the context. Ask whether the duty is now complete and collect the actual departure time, or establish when another follow-up should occur.", post: "Extract the latest check-out outcome and explicitly reported departure or callback time. Do not treat the scheduled time as an actual time; follow the required output schema." },
];

const DEFAULT_CALL_PROMPTS = Object.fromEntries(CALL_PROMPT_SCENARIOS.map(({ id, live, post }) => [id, { live, post }]));

function normalizeCallPrompts(value) {
  const prompts = {};
  for (const { id } of CALL_PROMPT_SCENARIOS) {
    const candidate = value?.[id] || {};
    prompts[id] = {
      live: typeof candidate.live === "string" ? candidate.live.trim() : DEFAULT_CALL_PROMPTS[id].live,
      post: typeof candidate.post === "string" ? candidate.post.trim() : DEFAULT_CALL_PROMPTS[id].post,
    };
  }
  return prompts;
}

module.exports = { CALL_PROMPT_SCENARIOS, DEFAULT_CALL_PROMPTS, normalizeCallPrompts };
