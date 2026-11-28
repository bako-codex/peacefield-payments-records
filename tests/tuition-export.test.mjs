import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  createTuitionExportSheets,
  createTuitionWorkbook,
  getTuitionPaymentAmount,
  legacyTuitionStudentKey,
  sortRecordsByClass,
} from "../src/tuition-export.mjs";

const require = createRequire(import.meta.url);
const { createExamNumber, getStudentExamNumberDocumentId } = require("../lib/server/examNumbers.js");
const { studentRoster } = require("../lib/server/studentRoster.js");

const classKeyForRecord = (value) => String(value ?? "")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .replace(/^nursery(?=\d)/, "nur")
  .replace(/^sss/, "ss");

test("class sorting follows the session schedule and puts unknown classes last", () => {
  const records = [
    { class: "SSS 2" },
    { class: "Basic 3-4" },
    { class: "Nursery 1" },
    { class: "Reception" },
    { class: "KG 2" },
    { class: "Basic 1" },
    { class: "JSS 1" },
    { class: "Unknown" },
  ];

  assert.deepEqual(
    sortRecordsByClass(records, classKeyForRecord).map(({ class: className }) => className),
    ["Reception", "KG 2", "Nursery 1", "Basic 1", "Basic 3-4", "JSS 1", "SSS 2", "Unknown"],
  );
});

test("tuition payments use the item summary and transaction total, including outstanding records", () => {
  assert.equal(getTuitionPaymentAmount({
    paymentType: "OUTSTANDING",
    itemsSummary: "Tuition fee",
    total: 20000,
  }, 30100), 20000);
  assert.equal(getTuitionPaymentAmount({
    paymentType: "OUTSTANDING",
    itemsSummary: "Tuition fee",
    total: 50300,
  }, 30100), 30100);
  assert.equal(getTuitionPaymentAmount({
    itemsSummary: "Exercise books",
    total: 50300,
  }, 30100), 0);
  assert.equal(getTuitionPaymentAmount({
    itemsSummary: "Tuition fee",
    total: "NGN 20,000",
  }, 30100), 20000);
});

test("legacy exam ID lookup preserves the previous parent-email student key", () => {
  assert.equal(legacyTuitionStudentKey({
    studentName: "Ada  Okafor",
    class: "JSS 1",
    parentEmail: " Parent@Example.com ",
  }, classKeyForRecord), "ada okafor|jss1|parent@example.com");
});

test("exam numbers use the 000 prefix and a unique three-digit format", () => {
  const first = createExamNumber();
  const second = createExamNumber();
  const studentKey = "ada okafor|basic1|parent@example.com";
  const documentId = getStudentExamNumberDocumentId(studentKey);

  assert.match(first, /^000\d{3}$/);
  assert.match(second, /^000\d{3}$/);
  assert.notEqual(first.slice(3), "000");
  assert.notEqual(second.slice(3), "000");
  assert.equal(getStudentExamNumberDocumentId(studentKey), documentId);
  assert.notEqual(getStudentExamNumberDocumentId(`${studentKey}|different`), documentId);
  assert.match(documentId, /^[a-f0-9]{64}$/);
});

test("export sheets group visible student records and separate complete from incomplete tuition", () => {
  const records = [
    { studentName: "Ada Okafor", class: "Basic 1", parentEmail: "parent@example.com" },
    { studentName: "Ada  Okafor", class: "Basic 1", parentEmail: "PARENT@example.com" },
    { studentName: "Bola Bello", class: "JSS 1", parentEmail: "other@example.com" },
    { studentName: "Chika Cole", class: "Unknown", parentEmail: "third@example.com" },
  ];
  const statuses = new Map([
    ["ada okafor|basic1", { state: "complete", paid: 34450, rate: 34450 }],
    ["bola bello|jss1", { state: "partial", paid: 10000, rate: 36300 }],
    ["chika cole|unknown", { state: "unavailable", paid: 0 }],
  ]);
  const sheets = createTuitionExportSheets(records, statuses, classKeyForRecord, new Map([
    ["ada okafor|basic1", "000201"],
  ]));

  assert.equal(sheets.paid.length, 1);
  assert.equal(sheets.paid[0]["Student name"], "Ada Okafor");
  assert.equal(sheets.paid[0]["Exam number"], "000201");
  assert.equal(sheets.notPaid.length, 2);
  assert.equal(sheets.notPaid[0]["Exam number"], "");
  assert.equal(sheets.notPaid[0].Status, "Partially paid");
  assert.equal(sheets.notPaid[0]["Balance (NGN)"], 26300);
  assert.equal(sheets.notPaid[1].Status, "Needs review");
  assert.equal(sheets.notPaid[1]["Balance (NGN)"], null);
});

test("roster export retains previous payment students and includes their saved exam numbers", () => {
  assert.equal(studentRoster.length, 153);
  const examNumbers = new Map(studentRoster.map((student, index) => [
    `${student.name.toLocaleLowerCase()}|${student.className.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")}`,
    `000${String(index + 1).padStart(3, "0")}`,
  ]));
  examNumbers.set("previous student|jss1", "000999");
  const records = [
    { studentName: "Amanie Joseph", class: "JSS 1", parentEmail: "amanie@example.com" },
    { studentName: "Previous Student", class: "JSS 1", parentEmail: "previous@example.com" },
  ];
  const statuses = new Map([
    ["amanie joseph|jss1", { state: "complete", paid: 36300, rate: 36300 }],
    ["previous student|jss1", { state: "complete", paid: 36300, rate: 36300 }],
  ]);
  const sheets = createTuitionExportSheets(records, statuses, classKeyForRecord, examNumbers, studentRoster);

  assert.equal(sheets.paid.length, 2);
  assert.equal(sheets.paid[0]["Student name"], "Amanie Joseph");
  assert.equal(sheets.paid[0]["Parent email"], "amanie@example.com");
  assert.equal(sheets.paid[0]["Exam number"], "000001");
  assert.equal(sheets.paid[1]["Student name"], "Previous Student");
  assert.equal(sheets.paid[1]["Exam number"], "000999");
  assert.equal(sheets.notPaid.length, 152);
  assert.equal(sheets.notPaid[0]["Student name"], "Elochukwu David");
  assert.equal(sheets.notPaid[0]["Exam number"], "000002");
});

test("workbook contains the two named worksheets and exported rows", async () => {
  const buffer = createTuitionWorkbook({
    paid: [{ "Student name": "Ada Okafor", Class: "Basic 1", "Parent email": "parent@example.com", Status: "Paid in full", "Tuition due (NGN)": 34450, "Tuition paid (NGN)": 34450, "Balance (NGN)": 0, "Exam number": "000201" }],
    notPaid: [{ "Student name": "Bola Bello", Class: "JSS 1", "Parent email": "other@example.com", Status: "Partially paid", "Tuition due (NGN)": 36300, "Tuition paid (NGN)": 10000, "Balance (NGN)": 26300 }],
  });
  const files = unzipSync(buffer);
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const paidSheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const notPaidSheet = strFromU8(files["xl/worksheets/sheet2.xml"]);

  assert.match(workbook, /name="Paid in full"/);
  assert.match(workbook, /name="Not paid in full"/);
  assert.match(paidSheet, /<autoFilter ref="A1:H2"\/>/);
  assert.match(paidSheet, /<t xml:space="preserve">Exam number<\/t>/);
  assert.match(paidSheet, /<c r="H2" t="inlineStr"><is><t xml:space="preserve">000201<\/t><\/is><\/c>/);
  assert.match(paidSheet, /<t xml:space="preserve">Ada Okafor<\/t>/);
  assert.match(paidSheet, /<v>34450<\/v>/);
  assert.match(notPaidSheet, /<t xml:space="preserve">Student name<\/t>/);
  assert.match(notPaidSheet, /<c r="G2" s="3"><f>MAX\(E2-F2,0\)<\/f><v>26300<\/v><\/c>/);
});
