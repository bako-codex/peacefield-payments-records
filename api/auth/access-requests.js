const { authenticateRequest, getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const { FieldValue } = require("firebase-admin/firestore");
const {
  ACCESS_CODE_DURATION_MS,
  createOtp,
  hashOtp,
  normalizeEmail,
} = require("../../lib/server/access");

function isAdmin(email) {
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
  return Boolean(email && admins.includes(normalizeEmail(email)));
}

function requireAdmin() {
  const error = new Error("Only configured administrators can manage access requests.");
  error.status = 403;
  throw error;
}

async function sendAccessCode(email, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL_FROM;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const appUrl = process.env.APP_URL || (host ? `https://${host}` : "");
  if (!apiKey || !senderEmail || !appUrl) {
    const error = new Error("Email delivery is not configured. Set BREVO_API_KEY, EMAIL_FROM, and APP_URL.");
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
        `Visit ${new URL(appUrl).origin}.`,
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

module.exports = async function accessRequests(request, response) {
  if (!["GET", "PATCH"].includes(request.method)) {
    response.setHeader("Allow", "GET, PATCH");
    sendJson(response, 405, { error: "Use GET or PATCH to manage access requests." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    if (!isAdmin(decoded.email)) {
      requireAdmin();
    }

    const { db, Timestamp } = getServices();
    const requests = db.collection("authAccessRequests");
    if (request.method === "GET") {
      const snapshot = await requests.orderBy("createdAt", "desc").limit(100).get();
      sendJson(response, 200, {
        requests: snapshot.docs.map((document) => {
          const data = document.data();
          return {
            id: document.id,
            name: data.name,
            email: data.email,
            status: data.status,
            createdAt: data.createdAt?.toDate().toISOString() || null,
            expiresAt: data.expiresAt?.toDate().toISOString() || null,
          };
        }),
      });
      return;
    }

    const { action, id } = request.body || {};
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || !["approve", "reject", "send-code"].includes(action)) {
      sendJson(response, 400, { error: "Choose a valid request and action." });
      return;
    }

    const requestRef = requests.doc(id);
    if (action === "approve" || action === "reject") {
      const updated = await db.runTransaction(async (transaction) => {
        const accessRequest = await transaction.get(requestRef);
        if (!accessRequest.exists || accessRequest.get("status") !== "pending") return false;
        transaction.update(requestRef, action === "approve"
          ? {
              status: "approved",
              approvedAt: Timestamp.now(),
              approvedBy: decoded.uid,
            }
          : {
              status: "rejected",
              rejectedAt: Timestamp.now(),
              rejectedBy: decoded.uid,
            });
        return true;
      });
      if (!updated) {
        sendJson(response, 409, { error: "This request is no longer waiting for a decision." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    const otp = createOtp();
    const now = Date.now();
    const expiresAt = new Date(now + ACCESS_CODE_DURATION_MS);
    const reservation = await db.runTransaction(async (transaction) => {
      const accessRequest = await transaction.get(requestRef);
      if (!accessRequest.exists) return { error: "not-found" };
      const status = accessRequest.get("status");
      if (status !== "approved" && status !== "code_sent" && status !== "sending_code") {
        return { error: "not-approved" };
      }
      const sentAt = status === "sending_code"
        ? accessRequest.get("sendStartedAt")
        : accessRequest.get("sentAt");
      if (sentAt && now - sentAt.toMillis() < 60_000) return { error: "rate-limited" };
      transaction.update(requestRef, {
        status: "sending_code",
        otpHash: hashOtp(accessRequest.get("email"), otp),
        otpExpiresAt: Timestamp.fromDate(expiresAt),
        expiresAt: Timestamp.fromDate(expiresAt),
        otpAttempts: 0,
        sendStartedAt: Timestamp.now(),
      });
      return { email: accessRequest.get("email") };
    });
    if (reservation.error) {
      const messages = {
        "not-found": [404, "Access request not found."],
        "not-approved": [409, "Approve this request before sending an access code."],
        "rate-limited": [429, "Wait one minute before sending another code."],
      };
      const [status, message] = messages[reservation.error];
      sendJson(response, status, { error: message });
      return;
    }

    try {
      await sendAccessCode(reservation.email, otp);
    } catch (error) {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(requestRef);
        if (current.exists && current.get("status") === "sending_code" &&
            current.get("otpHash") === hashOtp(reservation.email, otp)) {
          transaction.update(requestRef, {
            status: "approved",
            otpHash: FieldValue.delete(),
            otpExpiresAt: FieldValue.delete(),
            expiresAt: FieldValue.delete(),
            otpAttempts: FieldValue.delete(),
            sentAt: Timestamp.now(),
            sendStartedAt: FieldValue.delete(),
          });
        }
      });
      throw error;
    }

    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(requestRef);
      if (!current.exists || current.get("status") !== "sending_code" ||
          current.get("otpHash") !== hashOtp(reservation.email, otp)) {
        throw new Error("The access request changed while its code was being sent.");
      }
      transaction.update(requestRef, {
        status: "code_sent",
        sentAt: Timestamp.now(),
        sendStartedAt: FieldValue.delete(),
      });
    });
    sendJson(response, 200, { ok: true, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    handleApiError(response, error, "Could not manage access requests.");
  }
};
