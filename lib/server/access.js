const { createHash, randomInt } = require("node:crypto");

const ACCESS_CODE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return String(email ?? "").trim().toLocaleLowerCase();
}

function hashEmail(email) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function createOtp() {
  return String(randomInt(100000, 1000000));
}

function hashOtp(email, code) {
  return createHash("sha256").update(`${normalizeEmail(email)}:${String(code)}`).digest("hex");
}

module.exports = { ACCESS_CODE_DURATION_MS, createOtp, hashEmail, hashOtp, normalizeEmail };
