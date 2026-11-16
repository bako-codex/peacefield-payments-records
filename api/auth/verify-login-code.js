const {
  authenticateRequest,
  getServices,
  handleApiError,
  setOtpAuthenticated,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const { hashOtp } = require("../../lib/server/access");

module.exports = async function verifyLoginCode(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to verify a sign-in code." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request, {
      requireVerified: false,
      requireOtpAuthenticated: false,
    });
    const { otpCode } = request.body || {};
    if (!decoded.email || !decoded.email_verified || typeof otpCode !== "string" || !/^\d{6}$/.test(otpCode)) {
      sendJson(response, 400, { error: "Enter the six-digit sign-in code sent to your email." });
      return;
    }

    const { db, Timestamp } = getServices();
    const challengeRef = db.collection("authLoginChallenges").doc(decoded.uid);
    const verified = await db.runTransaction(async (transaction) => {
      const challenge = await transaction.get(challengeRef);
      const expiresAt = challenge.get("expiresAt");
      if (
        !challenge.exists ||
        challenge.get("status") !== "sent" ||
        challenge.get("attempts") >= 5 ||
        !expiresAt ||
        expiresAt.toMillis() <= Date.now() ||
        challenge.get("otpHash") !== hashOtp(decoded.email, otpCode)
      ) {
        if (challenge.exists && challenge.get("status") === "sent") {
          transaction.update(challengeRef, {
            attempts: (challenge.get("attempts") || 0) + 1,
          });
        }
        return false;
      }
      transaction.update(challengeRef, {
        status: "used",
        usedAt: Timestamp.now(),
      });
      return true;
    });
    if (!verified) {
      sendJson(response, 403, { error: "The sign-in code is invalid, expired, or has already been used." });
      return;
    }

    await setOtpAuthenticated(decoded.uid, decoded.auth_time);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not verify the sign-in code.");
  }
};
