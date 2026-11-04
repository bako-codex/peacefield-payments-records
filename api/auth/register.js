const {
  getServices,
  handleApiError,
  authenticateRequest,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const { hashInvitation, normalizeEmail } = require("../../lib/server/invitation");
const { Timestamp } = require("firebase-admin/firestore");

module.exports = async function register(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to register an invited account." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request, { requireVerified: false });
    const email = normalizeEmail(decoded.email);
    const { displayName, invitationCode } = request.body || {};
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
    const isConfiguredAdmin = admins.includes(email);
    if (!email) {
      sendJson(response, 400, { error: "A verified email address is required." });
      return;
    }

    const { db } = getServices();
    const userRef = db.collection("users").doc(decoded.uid);
    const existingProfile = await userRef.get();
    if (existingProfile.exists && normalizeEmail(existingProfile.get("email")) !== email) {
      sendJson(response, 403, { error: "The signed-in email does not match this account profile." });
      return;
    }

    if (isConfiguredAdmin) {
      if (existingProfile.exists) {
        sendJson(response, 200, { ok: true });
        return;
      }
      await db.runTransaction(async (transaction) => {
        const profile = await transaction.get(userRef);
        if (profile.exists) {
          if (normalizeEmail(profile.get("email")) !== email) {
            const error = new Error("The signed-in email does not match this account profile.");
            error.status = 403;
            throw error;
          }
          return;
        }
        transaction.create(userRef, {
          email,
          displayName: String(displayName ?? "").trim().slice(0, 100),
          status: "pending_verification",
          createdAt: Timestamp.now(),
        });
      });
    } else {
      if (typeof invitationCode !== "string" || invitationCode.length < 20) {
        sendJson(response, 400, { error: "Enter a valid invitation code." });
        return;
      }
      const invitationRef = db.collection("authInvitations").doc(hashInvitation(invitationCode));
      await db.runTransaction(async (transaction) => {
        const [invitation, profile] = await Promise.all([
          transaction.get(invitationRef),
          transaction.get(userRef),
        ]);
        const expiry = invitation.get("expiresAt");
        if (
          !invitation.exists ||
          invitation.get("email") !== email ||
          invitation.get("usedAt") ||
          invitation.get("deliveryStatus") === "pending" ||
          !expiry ||
          expiry.toMillis() <= Date.now()
        ) {
          const error = new Error("This invitation is invalid, expired, or for a different email.");
          error.status = 403;
          throw error;
        }
        transaction.update(invitationRef, {
          usedAt: Timestamp.now(),
          usedBy: decoded.uid,
        });
        const accountData = {
          email,
          accessExpiresAt: expiry,
        };
        if (!profile.exists) {
          accountData.displayName = String(displayName ?? "").trim().slice(0, 100);
          accountData.status = "pending_verification";
          accountData.createdAt = Timestamp.now();
        }
        transaction.set(userRef, accountData, { merge: true });
      });
    }

    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not register this account.");
  }
};
