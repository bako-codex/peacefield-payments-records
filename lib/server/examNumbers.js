const { createHash, randomInt } = require("node:crypto");

const EXAM_NUMBER_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function createExamNumber() {
  let number = "";
  for (let index = 0; index < 6; index += 1) {
    number += EXAM_NUMBER_ALPHABET[randomInt(EXAM_NUMBER_ALPHABET.length)];
  }
  return number;
}

function getStudentExamNumberDocumentId(studentKey) {
  return createHash("sha256").update(studentKey).digest("hex");
}

module.exports = {
  createExamNumber,
  getStudentExamNumberDocumentId,
};
