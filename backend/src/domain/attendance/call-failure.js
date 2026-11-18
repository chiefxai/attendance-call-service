"use strict";

const NO_ANSWER_FAILURE_CODES = new Set([
  "no_answer",
  "not_answered",
  "unanswered",
  "busy",
]);

function isNoAnswerFailureCode(code) {
  const normalized = String(code || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
  return NO_ANSWER_FAILURE_CODES.has(normalized);
}

module.exports = { isNoAnswerFailureCode };
