#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const keys = [
  "JWT_SIGNING_KEY",
  "MFA_ENCRYPTION_KEY",
  "PASSWORD_ENCRYPTION_KEY",
  "INTEGRATION_SECRET_KEY",
  "COOKIE_SIGNING_KEY",
  "CSRF_SIGNING_KEY",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
];

for (const k of keys) {
  const len = k.endsWith("PASSWORD") ? 24 : 32;
  // Passwords go into URLs (DATABASE_URL, REDIS_URL) so use URL-safe base64.
  // Signing keys are decoded server-side and can stay standard base64.
  const encoding = k.endsWith("PASSWORD") ? "base64url" : "base64";
  process.stdout.write(`${k}=${randomBytes(len).toString(encoding)}\n`);
}
