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
const { studentRoster } = require("../../lib/server/studentRoster");

const TRANSACTION_CONCURRENCY = 10;
const MAX_NUMBER_ATTEMPTS = 50;

async function getOrCreateRosterExamNumber(db, Timestamp, student, uid) {
  const studentKey = `${student.name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}|${student.className.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const studentId = getStudentExamNumberDocumentId(studentKey);
  const studentRef = db.collection("studentExamNumbers").doc(studentId);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(studentRef);
    let previousNumberRef = null;
    let previousRegistration = null;
    let previousNumber = null;
    if (existing.exists) {
      previousNumber = existing.get("examNumber");
      if (/^000\d{3}$/.test(previousNumber || "")) {
        previousNumberRef = db.collection("examNumberRegistry").doc(previousNumber);
        previousRegistration = await transaction.get(previousNumberRef);
        if (!previousRegistration.exists) {
          transaction.create(previousNumberRef, {
            studentId,
            createdAt: Timestamp.now(),
            createdBy: uid,
          });
          return previousNumber;
        }
        if (previousRegistration.get("studentId") === studentId) {
          return previousNumber;
        }
      }
    }

    const attempted = new Set();
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
      const number = createExamNumber();
      if (attempted.has(number)) continue;
      attempted.add(number);
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
          studentName: student.name,
          className: student.className,
          studentKey,
          updatedAt: Timestamp.now(),
          updatedBy: uid,
        });
        if (previousNumberRef && previousRegistration?.exists &&
            previousRegistration.get("studentId") === studentId) {
          transaction.delete(previousNumberRef);
        }
      } else {
        transaction.create(studentRef, {
          examNumber: number,
          studentName: student.name,
          className: student.className,
          studentKey,
          createdAt: Timestamp.now(),
          createdBy: uid,
        });
      }
      return number;
    }
    throw new Error(`Could not allocate a unique exam number for ${student.name}.`);
  });
}

module.exports = async function roster(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { error: "Use GET or POST for the student roster." });
    return;
  }

  try {
    const decoded = await authenticateRequest(request);
    await requireActiveUser(decoded);
    const { db, Timestamp } = getServices();
    const examNumbers = {};

    for (let index = 0; index < studentRoster.length; index += TRANSACTION_CONCURRENCY) {
      const students = studentRoster.slice(index, index + TRANSACTION_CONCURRENCY);
      const assigned = await Promise.all(students.map(async (student) => ({
        student,
        examNumber: await getOrCreateRosterExamNumber(db, Timestamp, student, decoded.uid),
      })));
      assigned.forEach(({ student, examNumber }) => {
        const studentKey = `${student.name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}|${student.className.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")}`;
        examNumbers[studentKey] = examNumber;
      });
    }

    sendJson(response, 200, {
      students: studentRoster,
      examNumbers,
    });
  } catch (error) {
    handleApiError(response, error, "Could not load or create the student exam roster.");
  }
};
