const {
  authenticateRequest,
  getServices,
  handleApiError,
  requireActiveUser,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const {
  LOGIN_OTP_DURATION_MS,
  createOtp,
  hashOtp,
} = require("../../lib/server/access");

async function sendLoginCode(email, otp) {
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
      subject: "Your Peacefield Records sign-in code",
      textContent: [
        `Your Peacefield Records sign-in code is ${otp}.`,
        "It expires in 10 minutes and can only be used once.",
        "Do not share this code with anyone.",
      ].join("\n\n"),
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo sign-in code email failed:", response.status, details);
    const error = new Error("The sign-in code email could not be sent. Check the email service configuration and try again.");
    error.status = 502;
    throw error;
  }
}

module.exports = async function requestLoginCode(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to request a sign-in code." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request, {
      requireVerified: false,
      requireOtpAuthenticated: false,
    });
    if (!decoded.email || !decoded.email_verified) {
      sendJson(response, 403, { error: "Verify your email through an approved access request before signing in." });
      return;
    }

    await requireActiveUser(decoded);
    const { db, Timestamp } = getServices();
    const challengeRef = db.collection("authLoginChallenges").doc(decoded.uid);
    const otp = createOtp();
    const codeHash = hashOtp(decoded.email, otp);
    const now = Date.now();
    const reservation = await db.runTransaction(async (transaction) => {
      const challenge = await transaction.get(challengeRef);
      const sentAt = challenge.get("sentAt");
      if (sentAt && now - sentAt.toMillis() < 60_000) {
        return { limited: true, previous: null };
      }
      transaction.set(challengeRef, {
        otpHash: codeHash,
        expiresAt: Timestamp.fromDate(new Date(now + LOGIN_OTP_DURATION_MS)),
        attempts: 0,
        status: "sending",
        sentAt: Timestamp.fromDate(new Date(now)),
      });
      return { limited: false, previous: challenge.exists ? challenge.data() : null };
    });
    if (reservation.limited) {
      sendJson(response, 200, {
        ok: true,
        message: "A code was sent recently. Check your inbox or wait one minute to request another.",
      });
      return;
    }

    try {
      await sendLoginCode(decoded.email, otp);
    } catch (error) {
      await db.runTransaction(async (transaction) => {
        const challenge = await transaction.get(challengeRef);
        if (challenge.exists && challenge.get("otpHash") === codeHash) {
          if (reservation.previous) transaction.set(challengeRef, reservation.previous);
          else transaction.delete(challengeRef);
        }
      });
      throw error;
    }

    await db.runTransaction(async (transaction) => {
      const challenge = await transaction.get(challengeRef);
      if (!challenge.exists || challenge.get("otpHash") !== codeHash) {
        throw new Error("The sign-in challenge changed while its code was being sent.");
      }
      transaction.update(challengeRef, { status: "sent" });
    });
    sendJson(response, 200, {
      ok: true,
      message: "A sign-in code has been sent. It expires in 10 minutes.",
      expiresInSeconds: LOGIN_OTP_DURATION_MS / 1000,
    });
  } catch (error) {
    handleApiError(response, error, "Could not send a sign-in code.");
  }
};
