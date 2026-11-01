const { createHash, randomBytes } = require("node:crypto");

function normalizeEmail(email) {
  return String(email ?? "").trim().toLocaleLowerCase();
}

function hashInvitation(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

function createInvitationCode() {
  return randomBytes(24).toString("base64url");
}

module.exports = { createInvitationCode, hashInvitation, normalizeEmail };
