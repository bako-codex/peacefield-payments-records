const {
  getServices,
  handleApiError,
  authenticateRequest,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const { hashInvitation, hashOtp, normalizeEmail } = require("../../lib/server/invitation");
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
    const { displayName, otpCode } = request.body || {};
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

    if (isConfiguredAdmin && existingProfile.exists && !otpCode) {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (isConfiguredAdmin && !existingProfile.exists) {
      const challengeRef = db.collection("authOtpChallenges").doc(hashInvitation(email));
      const validCode = typeof otpCode === "string" && /^\d{6}$/.test(otpCode);
      const registered = await db.runTransaction(async (transaction) => {
        const [challenge, profile] = await Promise.all([
          transaction.get(challengeRef),
          transaction.get(userRef),
        ]);
        if (profile.exists) return false;
        const expiresAt = challenge.get("expiresAt");
        if (
          !challenge.exists ||
          challenge.get("usedAt") ||
          challenge.get("attempts") >= 5 ||
          !expiresAt ||
          expiresAt.toMillis() <= Date.now() ||
          !validCode ||
          challenge.get("otpHash") !== hashOtp(email, otpCode)
        ) {
          if (challenge.exists && !challenge.get("usedAt")) {
            transaction.update(challengeRef, { attempts: (challenge.get("attempts") || 0) + 1 });
          }
          return false;
        }
        transaction.update(challengeRef, { usedAt: Timestamp.now() });
        transaction.create(userRef, {
          email,
          displayName: String(displayName ?? "").trim().slice(0, 100),
          status: "pending_verification",
          createdAt: Timestamp.now(),
        });
        return true;
      });
      if (!registered) {
        sendJson(response, 403, { error: "The one-time code is invalid, expired, or has already been used." });
        return;
      }
    } else if (!isConfiguredAdmin || otpCode) {
      if (typeof otpCode !== "string" || !/^\d{6}$/.test(otpCode)) {
        sendJson(response, 400, { error: "Enter the six-digit code sent to your email." });
        return;
      }
      if (isConfiguredAdmin) {
        const challengeRef = db.collection("authOtpChallenges").doc(hashInvitation(email));
        const registered = await db.runTransaction(async (transaction) => {
          const challenge = await transaction.get(challengeRef);
          const expiry = challenge.get("expiresAt");
          if (
            !challenge.exists ||
            challenge.get("usedAt") ||
            challenge.get("attempts") >= 5 ||
            !expiry ||
            expiry.toMillis() <= Date.now() ||
            challenge.get("otpHash") !== hashOtp(email, otpCode)
          ) {
            if (challenge.exists && !challenge.get("usedAt")) {
              transaction.update(challengeRef, { attempts: (challenge.get("attempts") || 0) + 1 });
            }
            return false;
          }
          transaction.update(challengeRef, { usedAt: Timestamp.now() });
          return true;
        });
        if (!registered) {
          sendJson(response, 403, { error: "The one-time code is invalid, expired, or has already been used." });
          return;
        }
      } else {
        const invitationQuery = db.collection("authInvitations").where("email", "==", email).limit(10);
        const registered = await db.runTransaction(async (transaction) => {
          const [invitations, profile] = await Promise.all([
            transaction.get(invitationQuery),
            transaction.get(userRef),
          ]);
          const invitation = invitations.docs.find((document) => {
            const expiry = document.get("expiresAt");
            return !document.get("usedAt") &&
              document.get("deliveryStatus") !== "pending" &&
              expiry &&
              expiry.toMillis() > Date.now();
          });
          if (!invitation) return false;
          const expiry = invitation.get("expiresAt");
          const otpExpiry = invitation.get("otpExpiresAt") || expiry;
          if (
            invitation.get("otpAttempts") >= 5 ||
            !otpExpiry ||
            otpExpiry.toMillis() <= Date.now() ||
            invitation.get("otpHash") !== hashOtp(email, otpCode)
          ) {
            transaction.update(invitation.ref, { otpAttempts: (invitation.get("otpAttempts") || 0) + 1 });
            return false;
          }
          if (profile.exists && normalizeEmail(profile.get("email")) !== email) return false;
          transaction.update(invitation.ref, {
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
          return true;
        });
        if (!registered) {
          sendJson(response, 403, { error: "The one-time code is invalid, expired, or has already been used for this invitation." });
          return;
        }
      }
    }

    await getServices().auth.updateUser(decoded.uid, { emailVerified: true });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not register this account.");
  }
};
