const {
  authenticateRequest,
  clearOtpAuthenticated,
  handleApiError,
  sendJson,
} = require("../../lib/server/firebaseAdmin");

module.exports = async function clearLoginOtp(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to end the verified sign-in session." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request, { requireOtpAuthenticated: false });
    await clearOtpAuthenticated(decoded.uid);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    handleApiError(response, error, "Could not end the verified sign-in session.");
  }
};
