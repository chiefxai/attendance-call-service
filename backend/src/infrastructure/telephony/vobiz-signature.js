"use strict";

const crypto = require("node:crypto");

function baseUrl(req) {
  const proto = (req.get?.("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = (req.get?.("x-forwarded-host") || req.get?.("host") || req.headers?.host || "").split(",")[0].trim();
  return `${proto}://${host}${req.baseUrl || ""}${req.path || ""}`;
}

function equalSignature(got, expected) {
  if (!got || !expected) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(req, authToken) {
  if (!authToken) return false;
  const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  for (const version of ["v3", "v2"]) {
    for (const suffix of ["", "-ma"]) {
      const signature = headers[`x-vobiz-signature${suffix}-${version}`];
      const nonce = headers[`x-vobiz-signature${suffix}-${version}-nonce`] || "";
      if (!signature) continue;
      const signedValue = version === "v3" ? `${baseUrl(req)}.${nonce}` : `${baseUrl(req)}${nonce}`;
      const expected = crypto.createHmac("sha256", authToken).update(signedValue).digest("base64");
      if (equalSignature(signature, expected)) return true;
    }
  }
  return false;
}

module.exports = { verifyVobizWebhookSignature: verifySignature };
