const { createHash, randomInt } = require("node:crypto");

function createExamNumber() {
  return `000${String(randomInt(1, 1000)).padStart(3, "0")}`;
}

function getStudentExamNumberDocumentId(studentKey) {
  return createHash("sha256").update(studentKey).digest("hex");
}

module.exports = {
  createExamNumber,
  getStudentExamNumberDocumentId,
};
