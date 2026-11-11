const { getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const { hashInvitation, hashOtp, normalizeEmail } = require("../../lib/server/invitation");

module.exports = async function verifyOtp(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to verify a code." });
    return;
  }
  const email = normalizeEmail(request.body?.email);
  const code = request.body?.otpCode;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    sendJson(response, 400, { error: "Enter your email and the six-digit code." });
    return;
  }

  try {
    const { db } = getServices();
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
    const invitationQuery = db.collection("authInvitations").where("email", "==", email).limit(10);
    const verified = await db.runTransaction(async (transaction) => {
      const invitations = await transaction.get(invitationQuery);
      const invitation = invitations.docs.find((document) => {
        const expiry = document.get("expiresAt");
        return !document.get("usedAt") &&
          document.get("deliveryStatus") === "sent" &&
          expiry &&
          expiry.toMillis() > Date.now();
      });
      if (invitation) {
        const otpExpiry = invitation.get("otpExpiresAt") || invitation.get("expiresAt");
        if (invitation.get("otpAttempts") >= 5) return false;
        if (
          !otpExpiry ||
          otpExpiry.toMillis() <= Date.now() ||
          invitation.get("otpHash") !== hashOtp(email, code)
        ) {
          transaction.update(invitation.ref, { otpAttempts: (invitation.get("otpAttempts") || 0) + 1 });
          return false;
        }
        return true;
      }

      if (!admins.includes(email)) return false;
      const challengeRef = db.collection("authOtpChallenges").doc(hashInvitation(email));
      const challenge = await transaction.get(challengeRef);
      const expiresAt = challenge.get("expiresAt");
      if (
        !challenge.exists ||
        challenge.get("usedAt") ||
        challenge.get("attempts") >= 5 ||
        !expiresAt ||
        expiresAt.toMillis() <= Date.now()
      ) return false;
      if (challenge.get("otpHash") !== hashOtp(email, code)) {
        transaction.update(challengeRef, { attempts: (challenge.get("attempts") || 0) + 1 });
        return false;
      }
      return true;
    });
    if (!verified) {
      sendJson(response, 403, { error: "The code is invalid, expired, or has reached its attempt limit." });
      return;
    }
    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not verify this code.");
  }
};
