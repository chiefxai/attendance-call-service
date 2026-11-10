"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "attendance_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function cookieToken(req) {
  const cookieHeader = String(req.headers.cookie || "");
  const pair = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  return pair ? decodeURIComponent(pair.slice(COOKIE_NAME.length + 1)) : "";
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function checkPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuthRouter({ express, repository }) {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.post("/login", async (req, res) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const prior = loginFailures.get(ip);
    if (prior && prior.until > now && prior.count >= MAX_LOGIN_FAILURES) {
      res.set("Retry-After", String(Math.ceil((prior.until - now) / 1000)));
      return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password || email.length > 254 || password.length > 1024) {
      return res.status(400).json({ error: "Enter your email and password." });
    }
    try {
      const user = await repository.findWebUserByEmail(email);
      const passwordValid = user
        ? checkPassword(password, user.passwordSalt, user.passwordHash)
        : checkPassword(password, "attendance-auth-dummy-salt", "0".repeat(128));
      if (!user || !user.active || !passwordValid) {
        const next = prior && prior.until > now ? { count: prior.count + 1, until: prior.until } : { count: 1, until: now + LOGIN_WINDOW_MS };
        loginFailures.set(ip, next);
        return res.status(401).json({ error: "Email or password is incorrect." });
      }
      loginFailures.delete(ip);
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(now + SESSION_TTL_MS);
      await repository.createWebSession(user.id, hash(token), expiresAt);
      res.set("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
      return res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
    } catch (error) {
      console.error("[attendance-auth] login failed", error.message);
      return res.status(500).json({ error: "Sign-in is temporarily unavailable." });
    }
  });

  router.get("/me", async (req, res) => {
    const token = cookieToken(req);
    if (!token) return res.status(401).json({ error: "Sign-in required." });
    try {
      const user = await repository.resolveWebSession(hash(token));
      if (!user) {
        res.set("Set-Cookie", sessionCookie("", 0));
        return res.status(401).json({ error: "Session expired. Sign in again." });
      }
      return res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
    } catch (error) {
      console.error("[attendance-auth] session lookup failed", error.message);
      return res.status(500).json({ error: "Session validation is temporarily unavailable." });
    }
  });

  router.post("/logout", async (req, res) => {
    const token = cookieToken(req);
    try {
      if (token) await repository.revokeWebSession(hash(token));
      res.set("Set-Cookie", sessionCookie("", 0));
      return res.json({ success: true });
    } catch (error) {
      console.error("[attendance-auth] logout failed", error.message);
      res.set("Set-Cookie", sessionCookie("", 0));
      return res.status(500).json({ error: "Could not revoke this session." });
    }
  });

  return router;
}

module.exports = { createAuthRouter, COOKIE_NAME, hash };
