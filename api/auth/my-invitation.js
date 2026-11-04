const {
  authenticateRequest,
  handleApiError,
  requireActiveUser,
  sendJson,
} = require("../../lib/server/firebaseAdmin");

module.exports = async function getMyInvitation(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "Use GET to check your invitation." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    const profile = await requireActiveUser(decoded);
    const admins = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase())
      .filter(Boolean);
    if (decoded.email && admins.includes(decoded.email.trim().toLocaleLowerCase())) {
      sendJson(response, 200, { expiresAt: null });
      return;
    }

    const expiry = profile.get("accessExpiresAt");
    sendJson(response, 200, {
      expiresAt: expiry?.toDate().toISOString() || null,
    });
  } catch (error) {
    handleApiError(response, error, "Could not check this account's invitation.");
  }
};
