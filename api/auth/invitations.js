const { authenticateRequest, getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const {
  createInvitationCode,
  createOtp,
  hashInvitation,
  hashOtp,
  INVITATION_DURATION_MS,
  normalizeEmail,
  OTP_DURATION_MS,
} = require("../../lib/server/invitation");

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function getAppUrl() {
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const configuredUrl = process.env.APP_URL || (vercelHost ? `https://${vercelHost}` : "");
  const appUrl = configuredUrl || (process.env.VERCEL ? "" : "http://127.0.0.1:5173");
  if (!appUrl) {
    const error = new Error("Set APP_URL to the deployed HTTPS website URL before sending invitations.");
    error.status = 503;
    throw error;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(appUrl);
  } catch {
    const error = new Error("APP_URL must be a valid website URL.");
    error.status = 503;
    throw error;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || (process.env.VERCEL && parsedUrl.protocol !== "https:")) {
    const error = new Error("APP_URL must use HTTPS on Vercel.");
    error.status = 503;
    throw error;
  }
  return parsedUrl.origin;
}

async function sendInvitationEmail({ email, otp, appUrl }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL_FROM;
  const senderName = process.env.EMAIL_FROM_NAME || "Peacefield Records";
  if (!apiKey || !senderEmail) {
    const error = new Error("Email delivery is not configured. Set BREVO_API_KEY and EMAIL_FROM to send invitations.");
    error.status = 503;
    throw error;
  }

  const safeAppUrl = escapeHtml(appUrl);
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email }],
      subject: "You're invited to Peacefield Records",
      textContent: [
        "You have been invited to the Peacefield Records staff portal.",
        `Enter this one-time code on the Peacefield Records website when you create your account: ${otp}`,
        "This code expires in 30 minutes and can only be used with the email address this message was sent to. The invitation expires in 7 days.",
        `Visit ${appUrl} and choose Create account.`,
      ].join("\n\n"),
      htmlContent: [
        "<!doctype html><html><body style=\"margin:0;background:#f7f4f6;font-family:Arial,sans-serif;color:#25212a\">",
        "<div style=\"max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #eee3e9;border-radius:16px\">",
        "<p style=\"margin:0 0 8px;color:#e6005d;font-weight:700;letter-spacing:1px\">PEACEFIELD PRIVATE SCHOOLS</p>",
        "<h1 style=\"margin:0 0 16px;font-size:24px\">You're invited to Peacefield Records</h1>",
        "<p style=\"line-height:1.6\">You have been invited to the secure staff portal. Enter this one-time code on the website when you create your account:</p>",
        `<p style="margin:24px 0;padding:16px;background:#fff4f8;border-radius:8px;color:#c90050;font-size:30px;font-weight:700;letter-spacing:8px;text-align:center">${otp}</p>`,
        "<p style=\"line-height:1.6\">This code expires in 30 minutes and is valid only for the email address this message was sent to. Do not share it.</p>",
        "<p style=\"line-height:1.6\">The invitation expires in 7 days.</p>",
        `<p style="margin-top:24px;font-size:13px;color:#6b6470\">Visit <a href="${safeAppUrl}" style="color:#c90050">${safeAppUrl}</a> and choose Create account.</p>`,
        `<p style="margin-top:24px;font-size:13px;color:#6b6470\">Peacefield Records · <a href="${safeAppUrl}" style="color:#c90050">${safeAppUrl}</a></p>`,
        "</div></body></html>",
      ].join(""),
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo invitation email failed:", response.status, details);
    let providerMessage = "";
    try {
      const body = JSON.parse(details);
      providerMessage = body.message || body.code || "";
    } catch {
      providerMessage = "";
    }
    const reason = response.status === 401 || response.status === 403
      ? "Brevo rejected the API key or it lacks transactional email permission."
      : response.status === 400
        ? `Brevo rejected the sender or recipient settings${providerMessage ? `: ${providerMessage}` : "."}`
        : response.status === 429
          ? "Brevo rate limit reached. Wait and try again."
          : `Brevo returned HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : "."}`;
    const error = new Error(`The invitation email was not sent. ${reason}`);
    error.status = 502;
    throw error;
  }
}

module.exports = async function createInvitation(request, response) {
  try {
    const decoded = await authenticateRequest(request);
    const admins = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean);
    const canInvite = Boolean(decoded.email && admins.includes(normalizeEmail(decoded.email)));
    if (request.method === "GET") {
      sendJson(response, 200, { canInvite });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      sendJson(response, 405, { error: "Use GET or POST to manage invitations." });
      return;
    }
    if (!canInvite) {
      sendJson(response, 403, { error: "Only configured administrators can invite staff." });
      return;
    }

    const email = normalizeEmail(request.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(response, 400, { error: "Enter a valid email address." });
      return;
    }

    const { db, Timestamp } = getServices();
    const appUrl = getAppUrl();
    const code = createInvitationCode();
    const otp = createOtp();
    const expiry = new Date(Date.now() + INVITATION_DURATION_MS);
    const otpExpiry = new Date(Math.min(Date.now() + OTP_DURATION_MS, expiry.getTime()));
    const invitationRef = db.collection("authInvitations").doc(hashInvitation(code));
    await invitationRef.create({
      email,
      createdBy: decoded.uid,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromDate(expiry),
      otpExpiresAt: Timestamp.fromDate(otpExpiry),
      otpHash: hashOtp(email, otp),
      otpAttempts: 0,
      otpSentAt: Timestamp.now(),
      deliveryStatus: "pending",
    });
    try {
      await sendInvitationEmail({ email, otp, appUrl });
      await invitationRef.update({ deliveryStatus: "sent", sentAt: Timestamp.now() });
    } catch (error) {
      await invitationRef.delete();
      throw error;
    }

    sendJson(response, 201, {
      email,
      expiresAt: expiry.toISOString(),
      emailSent: true,
    });
  } catch (error) {
    handleApiError(response, error, "Could not create an invitation.");
  }
};
