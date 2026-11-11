const { FieldPath } = require("firebase-admin/firestore");
const {
  authenticateRequest,
  getServices,
  handleApiError,
  requireActiveUser,
  sendJson,
} = require("../lib/server/firebaseAdmin");

const PAGE_SIZE = 50;

module.exports = async function payments(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "Only GET requests are supported." });
    return;
  }

  try {
    const identity = await authenticateRequest(request);
    await requireActiveUser(identity);
    const { db } = getServices();
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const fromMonth = requestUrl.searchParams.get("fromMonth") || "";
    const toMonth = requestUrl.searchParams.get("toMonth") || "";
    const hasMonthRange = Boolean(fromMonth || toMonth);
    const cursor = requestUrl.searchParams.get("cursor");
    if (cursor && cursor.length > 1500) {
      sendJson(response, 400, { error: "Invalid pagination cursor." });
      return;
    }

    let startTimestamp;
    let endTimestamp;
    if (hasMonthRange) {
      const parseMonth = (value) => {
        const match = /^(\d{4})-(\d{2})$/.exec(value);
        const year = match ? Number(match[1]) : 0;
        const monthNumber = match ? Number(match[2]) : 0;
        if (!match || year < 1 || year > 9998 || monthNumber < 1 || monthNumber > 12) {
          return null;
        }
        return { year, monthNumber };
      };
      const from = fromMonth ? parseMonth(fromMonth) : null;
      const to = toMonth ? parseMonth(toMonth) : null;
      if ((fromMonth && !from) || (toMonth && !to)) {
        sendJson(response, 400, { error: "Months must use the YYYY-MM format." });
        return;
      }
      if (from && to && fromMonth > toMonth) {
        sendJson(response, 400, {
          error: "The starting month must be on or before the ending month.",
        });
        return;
      }

      if (from) startTimestamp = `${fromMonth}-01T00:00:00.000Z`;
      if (to) {
        const nextYear = to.monthNumber === 12 ? to.year + 1 : to.year;
        const nextMonth = to.monthNumber === 12 ? 1 : to.monthNumber + 1;
        endTimestamp = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000Z`;
      }
    }

    let query = db.collection("payments");
    if (hasMonthRange) {
      if (startTimestamp) query = query.where("timestamp", ">=", startTimestamp);
      if (endTimestamp) query = query.where("timestamp", "<", endTimestamp);
      query = query.orderBy("timestamp").orderBy(FieldPath.documentId());
    } else {
      query = query.orderBy(FieldPath.documentId());
    }
    query = query.limit(PAGE_SIZE + 1);

    if (cursor) {
      if (hasMonthRange) {
        let position;
        try {
          position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          sendJson(response, 400, { error: "Invalid pagination cursor." });
          return;
        }
        if (
          !position ||
          typeof position.timestamp !== "string" ||
          typeof position.id !== "string"
        ) {
          sendJson(response, 400, { error: "Invalid pagination cursor." });
          return;
        }
        query = query.startAfter(position.timestamp, position.id);
      } else {
        query = query.startAfter(cursor);
      }
    }

    const snapshot = await query.get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const documents = snapshot.docs.slice(0, PAGE_SIZE);
    const records = documents.map((document) => {
      const fields = document.data();
      return {
        timestamp: fields.timestamp ?? null,
        studentName: fields.studentName ?? null,
        class: fields.class ?? null,
        paymentType: fields.paymentType ?? null,
        parentEmail: fields.parentEmail ?? null,
        itemsSummary: fields.itemsSummary ?? null,
        total: fields.total ?? null,
        transactionId: fields.transactionId ?? null,
        paystackReference: fields.paystackReference ?? null,
      };
    });

    sendJson(response, 200, {
      records,
      hasMore,
      nextCursor: hasMore
        ? hasMonthRange
          ? Buffer.from(JSON.stringify({
              timestamp: documents[documents.length - 1].get("timestamp"),
              id: documents[documents.length - 1].id,
            })).toString("base64url")
          : documents[documents.length - 1].id
        : null,
    });
  } catch (error) {
    if (error.status) {
      handleApiError(response, error);
    } else if (error.code === 7 || error.code === "permission-denied") {
      sendJson(response, 403, { error: "Access denied. Ask your administrator for Firestore access." });
    } else {
      handleApiError(response, error, "Could not load payment records.");
    }
  }
};
