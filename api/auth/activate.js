const { authenticateRequest, getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const { normalizeEmail } = require("../../lib/server/invitation");

module.exports = async function activate(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to activate an account." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    const { db, Timestamp } = getServices();
    const userRef = db.collection("users").doc(decoded.uid);
    const profile = await userRef.get();
    if (!profile.exists || normalizeEmail(profile.get("email")) !== normalizeEmail(decoded.email)) {
      sendJson(response, 403, { error: "This account was not created with a valid invitation." });
      return;
    }
    if (profile.get("status") !== "active") {
      await userRef.update({
        status: "active",
        emailVerifiedAt: Timestamp.now(),
      });
    }
    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not activate this account.");
  }
};
