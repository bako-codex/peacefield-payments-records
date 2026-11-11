const {
  getServices,
  handleApiError,
  authenticateRequest,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const { ACCESS_CODE_DURATION_MS, hashEmail, hashOtp, normalizeEmail } = require("../../lib/server/access");
const { Timestamp } = require("firebase-admin/firestore");

module.exports = async function register(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to register or renew approved account access." });
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
      const challengeRef = db.collection("authOtpChallenges").doc(hashEmail(email));
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
        const challengeRef = db.collection("authOtpChallenges").doc(hashEmail(email));
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
        const requestRef = db.collection("authAccessRequests").doc(hashEmail(email));
        const registered = await db.runTransaction(async (transaction) => {
          const [accessRequest, profile] = await Promise.all([
            transaction.get(requestRef),
            transaction.get(userRef),
          ]);
          if (!accessRequest.exists) return false;
          const expiry = accessRequest.get("expiresAt");
          const otpExpiry = accessRequest.get("otpExpiresAt");
          const codeMatches = accessRequest.get("otpHash") === hashOtp(email, otpCode);
          if (
            accessRequest.get("status") === "used" &&
            accessRequest.get("usedBy") === decoded.uid &&
            expiry &&
            expiry.toMillis() > Date.now() &&
            otpExpiry &&
            otpExpiry.toMillis() > Date.now() &&
            codeMatches
          ) return true;
          if (accessRequest.get("status") !== "code_sent") return false;
          if (
            accessRequest.get("otpAttempts") >= 5 ||
            !expiry ||
            expiry.toMillis() <= Date.now() ||
            !otpExpiry ||
            otpExpiry.toMillis() <= Date.now() ||
            !codeMatches
          ) {
            if (accessRequest.exists && accessRequest.get("status") === "code_sent") {
              transaction.update(requestRef, {
                otpAttempts: (accessRequest.get("otpAttempts") || 0) + 1,
              });
            }
            return false;
          }
          if (profile.exists && normalizeEmail(profile.get("email")) !== email) return false;
          const accessExpiry = Timestamp.fromDate(new Date(Date.now() + ACCESS_CODE_DURATION_MS));
          transaction.update(requestRef, {
            status: "used",
            usedAt: Timestamp.now(),
            usedBy: decoded.uid,
            accessExpiresAt: accessExpiry,
          });
          const accountData = {
            email,
            accessExpiresAt: accessExpiry,
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
          sendJson(response, 403, { error: "The one-time code is invalid, expired, or has already been used for this access request." });
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
