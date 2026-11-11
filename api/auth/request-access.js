const { getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const {
  ACCESS_CODE_DURATION_MS,
  createOtp,
  hashEmail,
  hashOtp,
  normalizeEmail,
} = require("../../lib/server/access");

function getAppUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const value = process.env.APP_URL || (host ? `https://${host}` : "");
  if (!value) {
    const error = new Error("Email delivery is not configured with a website URL.");
    error.status = 503;
    throw error;
  }
  return new URL(value).origin;
}

async function sendAccessCode(email, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL_FROM;
  if (!apiKey || !senderEmail) {
    const error = new Error("Email delivery is not configured. Set BREVO_API_KEY and EMAIL_FROM.");
    error.status = 503;
    throw error;
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: process.env.EMAIL_FROM_NAME || "Peacefield Records",
        email: senderEmail,
      },
      to: [{ email }],
      subject: "Your Peacefield Records access code",
      textContent: [
        `Your Peacefield Records one-time code is ${otp}.`,
        "It expires in 7 days. Enter it on the Peacefield Records website to create or renew your account access.",
        `Visit ${getAppUrl()}.`,
        "Do not share this code with anyone.",
      ].join("\n\n"),
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo access code email failed:", response.status, details);
    const error = new Error("The access code email could not be sent. Check the email service configuration and try again.");
    error.status = 502;
    throw error;
  }
}

module.exports = async function requestAccess(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to request staff access." });
    return;
  }

  const name = String(request.body?.name ?? "").trim().slice(0, 100);
  const email = normalizeEmail(request.body?.email);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(response, 400, { error: "Enter your name and a valid email address." });
    return;
  }

  try {
    const { db, Timestamp } = getServices();
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
    const now = Date.now();
    if (admins.includes(email)) {
      const code = createOtp();
      const challengeRef = db.collection("authOtpChallenges").doc(hashEmail(email));
      const codeHash = hashOtp(email, code);
      const sent = await db.runTransaction(async (transaction) => {
        const challenge = await transaction.get(challengeRef);
        const sentAt = challenge.get("otpSentAt");
        if (sentAt && now - sentAt.toMillis() < 60_000) return { sent: false };
        transaction.set(challengeRef, {
          otpHash: codeHash,
          otpExpiresAt: Timestamp.fromDate(new Date(now + ACCESS_CODE_DURATION_MS)),
          expiresAt: Timestamp.fromDate(new Date(now + ACCESS_CODE_DURATION_MS)),
          attempts: 0,
          otpSentAt: Timestamp.now(),
        });
        return { sent: true, previous: challenge.exists ? challenge.data() : null };
      });
      if (!sent.sent) {
        const error = new Error("Please wait one minute before requesting another code.");
        error.status = 429;
        throw error;
      }
      try {
        await sendAccessCode(email, code);
      } catch (error) {
        await db.runTransaction(async (transaction) => {
          const challenge = await transaction.get(challengeRef);
          if (challenge.exists && challenge.get("otpHash") === codeHash) {
            if (sent.previous) transaction.set(challengeRef, sent.previous);
            else transaction.delete(challengeRef);
          }
        });
        throw error;
      }
    } else {
      const requestRef = db.collection("authAccessRequests").doc(hashEmail(email));
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(requestRef);
        const status = existing.get("status");
        const expiry = existing.get("expiresAt");
        const activeCode = status === "code_sent" && expiry && expiry.toMillis() > now;
        if (existing.exists && (
          status === "pending" ||
          status === "approved" ||
          status === "sending_code" ||
          activeCode
        )) return;

        const lastRequestedAt = existing.get("lastRequestedAt");
        if (lastRequestedAt && now - lastRequestedAt.toMillis() < 60_000) {
          const error = new Error("Please wait one minute before submitting another request.");
          error.status = 429;
          throw error;
        }

        transaction.set(requestRef, {
          name,
          email,
          status: "pending",
          createdAt: Timestamp.now(),
          lastRequestedAt: Timestamp.now(),
        });
      });
    }

    sendJson(response, 200, {
      ok: true,
      message: "Your request has been received. If you're a configured administrator, check your email for a code. Otherwise, an administrator must approve your request before a code is sent.",
    });
  } catch (error) {
    handleApiError(response, error, "Could not submit your access request.");
  }
};
