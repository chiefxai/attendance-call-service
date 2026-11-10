"use strict";

function normalizeIndianMobile(value) {
  const compact = String(value || "").trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  const mobile = digits.length === 10
    ? digits
    : digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : "";
  return /^[6-9]\d{9}$/.test(mobile) ? \`+91\${mobile}\` : null;
}

module.exports = { normalizeIndianMobile };
