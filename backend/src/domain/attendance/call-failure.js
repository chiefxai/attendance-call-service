"use strict";

const NO_ANSWER_FAILURE_CODES = new Set([
  "no_answer",
  "noanswer",
  "no_answer_timeout",
  "no_pickup",
  "no_pick_up",
  "no_pickup_timeout",
  "call_not_answered",
  "not_answered",
  "notanswered",
  "unanswered",
  "busy",
  "user_busy",
  "subscriber_busy",
  // Unavailable post-call transcript means attendance is unverified; retry it.
  "no_transcript_data_error",
  "notranscriptdataerror",
  "recording_transcription_failed",
]);

function isNoAnswerFailureCode(code) {
  const normalized = String(code || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
  return NO_ANSWER_FAILURE_CODES.has(normalized);
}

module.exports = { isNoAnswerFailureCode };
