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

async function getOrCreateExamNumber(db, Timestamp, studentKey, uid, legacyStudentKeys = []) {
  const studentId = getStudentExamNumberDocumentId(studentKey);
  const studentRef = db.collection("studentExamNumbers").doc(studentId);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(studentRef);
    const aliasRefs = [...new Set(legacyStudentKeys)]
      .filter((key) => key !== studentKey)
      .map((key) => ({
        studentId: getStudentExamNumberDocumentId(key),
        ref: db.collection("studentExamNumbers").doc(getStudentExamNumberDocumentId(key)),
      }));
    const aliases = [];
    for (const alias of aliasRefs) {
      aliases.push({ ...alias, snapshot: await transaction.get(alias.ref) });
    }

    const previousNumber = existing.exists ? existing.get("examNumber") : null;
    const numbersToCheck = new Set([
      ...(typeof previousNumber === "string" && /^[A-Z0-9]{6}$/.test(previousNumber) ? [previousNumber] : []),
      ...aliases.map(({ snapshot }) => snapshot.get("examNumber"))
        .filter((number) => typeof number === "string" && /^[A-Z0-9]{6}$/.test(number)),
    ]);
    const registrations = new Map();
    for (const number of numbersToCheck) {
      registrations.set(number, await transaction.get(db.collection("examNumberRegistry").doc(number)));
    }

    const matchingAliases = aliases.filter(({ studentId: aliasId, snapshot }) => {
      if (!snapshot.exists) return false;
      const number = snapshot.get("examNumber");
      if (typeof number !== "string" || !/^[A-Z0-9]{6}$/.test(number)) return false;
      const registration = registrations.get(number);
      return !registration.exists ||
        registration.get("studentId") === aliasId ||
        registration.get("studentId") === studentId;
    });
    const aliasNumbers = new Set(matchingAliases.map(({ snapshot }) => snapshot.get("examNumber")));
    if (aliasNumbers.size > 1) {
      throw new Error("Multiple older exam numbers match this student. Ask an administrator to reconcile them before exporting.");
    }
    const legacyNumber = aliasNumbers.values().next().value;
    if (legacyNumber) {
      const legacyRegistrationRef = db.collection("examNumberRegistry").doc(legacyNumber);
      const legacyRegistration = registrations.get(legacyNumber);
      const currentRegistration = previousNumber
        ? registrations.get(previousNumber)
        : null;
      if (previousNumber && previousNumber !== legacyNumber && currentRegistration?.exists &&
          currentRegistration.get("studentId") === studentId) {
        transaction.delete(db.collection("examNumberRegistry").doc(previousNumber));
      }
      if (!legacyRegistration.exists) {
        transaction.create(legacyRegistrationRef, {
          studentId,
          createdAt: Timestamp.now(),
          createdBy: uid,
        });
      } else if (legacyRegistration.get("studentId") !== studentId) {
        transaction.update(legacyRegistrationRef, { studentId });
      }
      if (existing.exists) {
        transaction.update(studentRef, {
          examNumber: legacyNumber,
          updatedAt: Timestamp.now(),
          updatedBy: uid,
        });
      } else {
        transaction.create(studentRef, {
          examNumber: legacyNumber,
          createdAt: Timestamp.now(),
          createdBy: uid,
        });
      }
      matchingAliases.forEach(({ studentId: aliasId, ref, snapshot }) => {
        if (snapshot.get("examNumber") === legacyNumber && aliasId !== studentId) {
          transaction.delete(ref);
        }
      });
      return legacyNumber;
    }

    if (typeof previousNumber === "string" && /^000\d{3}$/.test(previousNumber)) {
      const registration = registrations.get(previousNumber);
      if (!registration.exists) {
        transaction.create(db.collection("examNumberRegistry").doc(previousNumber), {
          studentId,
          createdAt: Timestamp.now(),
          createdBy: uid,
        });
        return previousNumber;
      }
      if (registration.get("studentId") === studentId) return previousNumber;
    }

    const previousRegistration = previousNumber ? registrations.get(previousNumber) : null;
    const previousNumberRef = previousNumber
      ? db.collection("examNumberRegistry").doc(previousNumber)
      : null;
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
    const requestedStudents = request.body?.students;
    const studentKeys = Array.isArray(requestedStudents)
      ? requestedStudents.map((student) => student?.studentKey)
      : request.body?.studentKeys;
    if (
      !Array.isArray(studentKeys) ||
      studentKeys.length > MAX_STUDENTS_PER_REQUEST ||
      studentKeys.some((key) => !isValidStudentKey(key)) ||
      new Set(studentKeys).size !== studentKeys.length ||
      (Array.isArray(requestedStudents) && requestedStudents.some((student) =>
        !Array.isArray(student.legacyStudentKeys) ||
        student.legacyStudentKeys.length > 20 ||
        student.legacyStudentKeys.some((key) => !isValidStudentKey(key))))
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
        examNumber: await getOrCreateExamNumber(
          db,
          Timestamp,
          studentKey,
          decoded.uid,
          requestedStudents?.[index + keys.indexOf(studentKey)]?.legacyStudentKeys || [],
        ),
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
