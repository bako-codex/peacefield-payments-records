const {
  authenticateRequest,
  getServices,
  handleApiError,
  requireActiveUser,
  sendJson,
} = require("../../lib/server/firebaseAdmin");
const {
  createExamNumber,
  getStudentExamNumberDocumentId,
} = require("../../lib/server/examNumbers");

const MAX_STUDENTS_PER_REQUEST = 300;
const MAX_NUMBER_ATTEMPTS = 50;
const TRANSACTION_CONCURRENCY = 10;

function isValidStudentKey(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

async function getOrCreateExamNumber(db, Timestamp, studentKey, uid) {
  const studentId = getStudentExamNumberDocumentId(studentKey);
  const studentRef = db.collection("studentExamNumbers").doc(studentId);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(studentRef);
    let previousNumber = null;
    let previousNumberRef = null;
    let previousRegistration = null;
    if (existing.exists) {
      previousNumber = existing.get("examNumber");
      if (typeof previousNumber !== "string" || !/^[A-Z0-9]{6}$/.test(previousNumber)) {
        throw new Error("A stored student exam number is invalid.");
      }
      previousNumberRef = db.collection("examNumberRegistry").doc(previousNumber);
      previousRegistration = await transaction.get(previousNumberRef);
      if (/^000\d{3}$/.test(previousNumber) &&
          (!previousRegistration.exists || previousRegistration.get("studentId") === studentId)) {
        if (!previousRegistration.exists) {
          transaction.create(previousNumberRef, {
            studentId,
            createdAt: Timestamp.now(),
            createdBy: uid,
          });
        }
        return previousNumber;
      }
    }

    const attemptedNumbers = new Set();
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
      const number = createExamNumber();
      if (attemptedNumbers.has(number)) continue;
      attemptedNumbers.add(number);
      const numberRef = db.collection("examNumberRegistry").doc(number);
      const registered = await transaction.get(numberRef);
      if (registered.exists) continue;

      transaction.create(numberRef, {
        studentId,
        createdAt: Timestamp.now(),
        createdBy: uid,
      });
      if (existing.exists) {
        transaction.update(studentRef, {
          examNumber: number,
          updatedAt: Timestamp.now(),
          updatedBy: uid,
        });
        if (previousRegistration?.exists && previousRegistration.get("studentId") === studentId) {
          transaction.delete(previousNumberRef);
        }
      } else {
        transaction.create(studentRef, {
          examNumber: number,
          createdAt: Timestamp.now(),
          createdBy: uid,
        });
      }
      return number;
    }

    throw new Error("Could not allocate a unique numeric exam number. Please try again.");
  });
}

module.exports = async function examNumbers(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to create or retrieve student exam numbers." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    await requireActiveUser(decoded);
    const studentKeys = request.body?.studentKeys;
    if (
      !Array.isArray(studentKeys) ||
      studentKeys.length > MAX_STUDENTS_PER_REQUEST ||
      studentKeys.some((key) => !isValidStudentKey(key)) ||
      new Set(studentKeys).size !== studentKeys.length
    ) {
      sendJson(response, 400, { error: "Provide up to 300 unique valid student keys." });
      return;
    }

    const { db, Timestamp } = getServices();
    const examNumbers = new Map();
    for (let index = 0; index < studentKeys.length; index += TRANSACTION_CONCURRENCY) {
      const keys = studentKeys.slice(index, index + TRANSACTION_CONCURRENCY);
      const assigned = await Promise.all(keys.map(async (studentKey) => ({
        studentKey,
        examNumber: await getOrCreateExamNumber(db, Timestamp, studentKey, decoded.uid),
      })));
      assigned.forEach(({ studentKey, examNumber }) => {
        examNumbers.set(studentKey, examNumber);
      });
    }

    sendJson(response, 200, { examNumbers: Object.fromEntries(examNumbers) });
  } catch (error) {
    handleApiError(response, error, "Could not assign student exam numbers.");
  }
};
