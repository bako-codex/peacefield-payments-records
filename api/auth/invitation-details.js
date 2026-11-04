const { getServices, handleApiError, sendJson } = require("../../lib/server/firebaseAdmin");
const { hashInvitation, normalizeEmail } = require("../../lib/server/invitation");

module.exports = async function invitationDetails(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to look up an invitation." });
    return;
  }

  const { invitationCode } = request.body || {};
  if (typeof invitationCode !== "string" || invitationCode.length < 20) {
    sendJson(response, 400, { error: "Enter a valid invitation code." });
    return;
  }

  try {
    const { db } = getServices();
    const invitation = await db.collection("authInvitations").doc(hashInvitation(invitationCode)).get();
    const expiry = invitation.get("expiresAt");
    if (
      !invitation.exists ||
      invitation.get("usedAt") ||
      invitation.get("deliveryStatus") === "pending" ||
      !expiry ||
      expiry.toMillis() <= Date.now()
    ) {
      sendJson(response, 403, { error: "This invitation is invalid, expired, or has already been used." });
      return;
    }

    sendJson(response, 200, { email: normalizeEmail(invitation.get("email")) });
  } catch (error) {
    handleApiError(response, error, "Could not look up this invitation.");
  }
};
