const {
  getServices,
  handleApiError,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const {
  createOtp,
  hashInvitation,
  hashOtp,
  normalizeEmail,
  OTP_DURATION_MS,
} = require("../../lib/server/invitation");

function getAppUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const value = process.env.APP_URL || (host ? `https://${host}` : "");
  if (!value) {
    const error = new Error("Email verification is not configured with a website URL.");
    error.status = 503;
    throw error;
  }
  return new URL(value).origin;
}

async function sendOtp(email, otp, appUrl) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY || "",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: process.env.EMAIL_FROM_NAME || "Peacefield Records",
        email: process.env.EMAIL_FROM,
      },
      to: [{ email }],
      subject: "Your Peacefield Records verification code",
      textContent: `Your Peacefield Records one-time code is ${otp}. It expires in 30 minutes. Enter it on ${appUrl}.`,
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo OTP email failed:", response.status, details);
    const error = new Error("The verification code email could not be sent. Check the email service configuration and try again.");
    error.status = 502;
    throw error;
  }
}

module.exports = async function sendOtpCode(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to request a verification code." });
    return;
  }
  const email = normalizeEmail(request.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(response, 400, { error: "Enter a valid email address." });
    return;
  }

  try {
    const { db, Timestamp } = getServices();
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
    const isAdmin = admins.includes(email);
    const invitationQuery = db.collection("authInvitations").where("email", "==", email).limit(10);
    const candidates = await invitationQuery.get();
    const invitation = candidates.docs.find((document) => {
      const expiry = document.get("expiresAt");
      return !document.get("usedAt") &&
        document.get("deliveryStatus") === "sent" &&
        expiry &&
        expiry.toMillis() > Date.now();
    });

    if (!invitation && !isAdmin) {
      sendJson(response, 403, { error: "No active invitation was found for this email." });
      return;
    }

    const otp = createOtp();
    const targetRef = invitation?.ref || db.collection("authOtpChallenges").doc(hashInvitation(email));
    const updated = await db.runTransaction(async (transaction) => {
      const document = await transaction.get(targetRef);
      if ((invitation && !document.exists) || document.get("usedAt")) return false;
      const sentAt = document.get("otpSentAt") || document.get("lastSentAt");
      if (sentAt && Date.now() - sentAt.toMillis() < 60_000) return "already-sent";
      const expiry = document.get("expiresAt");
      if (invitation && (!expiry || expiry.toMillis() <= Date.now())) return false;
      const otpExpiry = new Date(Date.now() + OTP_DURATION_MS);
      transaction.set(targetRef, {
        otpHash: hashOtp(email, otp),
        otpExpiresAt: Timestamp.fromDate(invitation && expiry.toMillis() < otpExpiry.getTime()
          ? new Date(expiry.toMillis())
          : otpExpiry),
        otpAttempts: 0,
        attempts: 0,
        otpSentAt: Timestamp.now(),
        lastSentAt: Timestamp.now(),
        ...(!invitation ? { expiresAt: Timestamp.fromDate(otpExpiry) } : {}),
      }, { merge: true });
      return true;
    });
    if (updated === "already-sent") {
      sendJson(response, 200, { ok: true, message: "A code was already sent recently. Check your inbox and spam folder." });
      return;
    }
    if (!updated) {
      sendJson(response, 429, { error: "Please wait one minute before requesting another code, or ask your administrator for a new invitation." });
      return;
    }

    await sendOtp(email, otp, getAppUrl());
    sendJson(response, 200, { ok: true, message: "A new verification code has been sent." });
  } catch (error) {
    handleApiError(response, error, "Could not send a verification code.");
  }
};
