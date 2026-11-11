const { createHash, randomBytes, randomInt } = require("node:crypto");

const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const OTP_DURATION_MS = 30 * 60 * 1000;

function normalizeEmail(email) {
  return String(email ?? "").trim().toLocaleLowerCase();
}

function hashInvitation(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

function createInvitationCode() {
  return randomBytes(24).toString("base64url");
}

function createOtp() {
  return String(randomInt(100000, 1000000));
}

function hashOtp(email, code) {
  return createHash("sha256").update(`${normalizeEmail(email)}:${String(code)}`).digest("hex");
}

module.exports = {
  createInvitationCode,
  createOtp,
  hashInvitation,
  hashOtp,
  INVITATION_DURATION_MS,
  normalizeEmail,
  OTP_DURATION_MS,
};
