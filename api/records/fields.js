const {
  authenticateRequest,
  getServices,
  handleApiError,
  requireActiveUser,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const { normalizeEmail } = require("../../lib/server/access");

const allowedFields = [
  "timestamp",
  "studentName",
  "class",
  "paymentType",
  "parentEmail",
  "itemsSummary",
  "total",
  "transactionId",
  "paystackReference",
];

module.exports = async function recordFields(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { error: "Use GET or POST to manage displayed record fields." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    const { db, Timestamp } = getServices();
    await requireActiveUser(decoded);
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
    const canManage = Boolean(decoded.email && admins.includes(normalizeEmail(decoded.email)));
    const settingsRef = db.collection("appSettings").doc("recordFields");

    if (request.method === "GET") {
      const settings = await settingsRef.get();
      const storedFields = settings.get("fields");
      sendJson(response, 200, {
        canManage,
        fields: Array.isArray(storedFields)
          ? storedFields.filter((field) => allowedFields.includes(field))
          : allowedFields,
      });
      return;
    }

    if (!canManage) {
      sendJson(response, 403, { error: "Only configured administrators can change displayed record fields." });
      return;
    }
    const fields = request.body?.fields;
    if (
      !Array.isArray(fields) ||
      fields.length < 1 ||
      fields.length > allowedFields.length ||
      fields.some((field) => !allowedFields.includes(field)) ||
      new Set(fields).size !== fields.length
    ) {
      sendJson(response, 400, { error: "Select at least one valid record field." });
      return;
    }
    await settingsRef.set({
      fields,
      updatedAt: Timestamp.now(),
      updatedBy: decoded.uid,
    });
    sendJson(response, 200, { fields });
  } catch (error) {
    handleApiError(response, error, "Could not load or save displayed record fields.");
  }
};
