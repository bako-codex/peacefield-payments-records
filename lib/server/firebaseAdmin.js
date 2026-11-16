const { applicationDefault, cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { OTP_AUTH_SESSION_DURATION_MS } = require("./access");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "peacefield-payments-bf7c2";

function getAdminApp() {
  if (getApps().length) {
    return getApps()[0];
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccount && process.env.VERCEL) {
    const error = new Error("Firebase Admin credentials are missing on Vercel. Add FIREBASE_SERVICE_ACCOUNT_JSON in the project's server-side environment variables, then redeploy.");
    error.status = 503;
    throw error;
  }

  let credential;
  if (serviceAccount) {
    let parsedServiceAccount;
    try {
      parsedServiceAccount = JSON.parse(serviceAccount);
    } catch {
      const error = new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain the complete Firebase service-account JSON.");
      error.status = 503;
      throw error;
    }

    if (
      parsedServiceAccount.type !== "service_account" ||
      parsedServiceAccount.project_id !== PROJECT_ID ||
      !parsedServiceAccount.client_email ||
      !parsedServiceAccount.private_key
    ) {
      const error = new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be a service-account key for the configured Firebase project.");
      error.status = 503;
      throw error;
    }
    credential = cert(parsedServiceAccount);
  } else {
    credential = applicationDefault();
  }

  return initializeApp({
    credential,
    projectId: PROJECT_ID,
  });
}

function getServices() {
  const app = getAdminApp();
  return { auth: getAuth(app), db: getFirestore(app), Timestamp };
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function readBearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "");
  return match?.[1] || null;
}

async function authenticateRequest(request, {
  requireVerified = true,
  requireOtpAuthenticated = true,
} = {}) {
  const token = readBearerToken(request);
  if (!token) {
    const error = new Error("Sign in to continue.");
    error.status = 401;
    throw error;
  }

  const { auth } = getServices();
  const decoded = await auth.verifyIdToken(token, true);
  if (requireVerified && !decoded.email_verified) {
    const error = new Error("Verify your email address before continuing.");
    error.status = 403;
    throw error;
  }
  if (
    requireOtpAuthenticated &&
    (!Number.isInteger(decoded.otpAuthenticatedUntil) ||
      decoded.otpAuthenticatedUntil <= Math.floor(Date.now() / 1000) ||
      !Number.isInteger(decoded.otpAuthenticatedAuthTime) ||
      decoded.otpAuthenticatedAuthTime !== decoded.auth_time)
  ) {
    const error = new Error("Verify the one-time email code before continuing.");
    error.status = 403;
    throw error;
  }
  return decoded;
}

async function setOtpAuthenticated(uid, authTime) {
  if (!Number.isInteger(authTime)) {
    throw new Error("The Firebase sign-in time is missing or invalid.");
  }
  const { auth } = getServices();
  const user = await auth.getUser(uid);
  const customClaims = {
    ...user.customClaims,
    otpAuthenticatedAuthTime: authTime,
    otpAuthenticatedUntil: Math.floor((Date.now() + OTP_AUTH_SESSION_DURATION_MS) / 1000),
  };
  await auth.setCustomUserClaims(uid, customClaims);
}

async function clearOtpAuthenticated(uid) {
  const { auth } = getServices();
  const user = await auth.getUser(uid);
  const customClaims = { ...user.customClaims };
  delete customClaims.otpAuthenticatedAuthTime;
  delete customClaims.otpAuthenticatedUntil;
  await auth.setCustomUserClaims(uid, customClaims);
}

async function requireUnexpiredAccess(decoded, profile, userRef) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (decoded.email && admins.includes(decoded.email.trim().toLocaleLowerCase())) return null;

  let expiry = profile.get("accessExpiresAt");
  if (!expiry) {
    const { db } = getServices();
    const accessRequests = await db.collection("authAccessRequests")
      .where("usedBy", "==", decoded.uid)
      .limit(1)
      .get();
    expiry = accessRequests.docs[0]?.get("accessExpiresAt") || accessRequests.docs[0]?.get("expiresAt");
    if (expiry) await userRef.update({ accessExpiresAt: expiry });
  }

  if (!expiry || expiry.toMillis() <= Date.now()) {
    const error = new Error("Access to this account has expired. Submit a new access request, then enter the code after an administrator approves it.");
    error.status = 403;
    throw error;
  }
  return expiry;
}

async function requireActiveUser(decoded) {
  const { db } = getServices();
  const userRef = db.collection("users").doc(decoded.uid);
  let profile = await userRef.get();
  if (!profile.exists || profile.get("status") !== "active") {
    const error = new Error("This account has not been approved. Submit an access request or contact an administrator.");
    error.status = 403;
    throw error;
  }

  const expiry = await requireUnexpiredAccess(decoded, profile, userRef);
  if (expiry && !profile.get("accessExpiresAt")) profile = await userRef.get();
  return profile;
}

function handleApiError(response, error, message = "The server could not complete this request.") {
  if (error.status) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  console.error(message, error);
  sendJson(response, 500, { error: message });
}

module.exports = {
  authenticateRequest,
  clearOtpAuthenticated,
  getServices,
  handleApiError,
  readBearerToken,
  requireActiveUser,
  requireUnexpiredAccess,
  setOtpAuthenticated,
  sendJson,
};
