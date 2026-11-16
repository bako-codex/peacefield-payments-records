import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createTuitionExportSheets, createTuitionWorkbook } from "../src/tuition-export.mjs";

const classKeyForRecord = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

test("export sheets group visible student records and separate complete from incomplete tuition", () => {
  const records = [
    { studentName: "Ada Okafor", class: "Basic 1", parentEmail: "parent@example.com" },
    { studentName: "Ada  Okafor", class: "Basic 1", parentEmail: "PARENT@example.com" },
    { studentName: "Bola Bello", class: "JSS 1", parentEmail: "other@example.com" },
    { studentName: "Chika Cole", class: "Unknown", parentEmail: "third@example.com" },
  ];
  const statuses = new Map([
    ["ada okafor|basic1|parent@example.com", { state: "complete", paid: 34450, rate: 34450 }],
    ["bola bello|jss1|other@example.com", { state: "partial", paid: 10000, rate: 36300 }],
    ["chika cole|unknown|third@example.com", { state: "unavailable", paid: 0 }],
  ]);
  const sheets = createTuitionExportSheets(records, statuses, classKeyForRecord);

  assert.equal(sheets.paid.length, 1);
  assert.equal(sheets.paid[0]["Student name"], "Ada Okafor");
  assert.equal(sheets.notPaid.length, 2);
  assert.equal(sheets.notPaid[0].Status, "Partially paid");
  assert.equal(sheets.notPaid[0]["Balance (NGN)"], 26300);
  assert.equal(sheets.notPaid[1].Status, "Needs review");
  assert.equal(sheets.notPaid[1]["Balance (NGN)"], null);
});

test("workbook contains the two named worksheets and exported rows", async () => {
  const buffer = createTuitionWorkbook({
    paid: [{ "Student name": "Ada Okafor", Class: "Basic 1", "Parent email": "parent@example.com", Status: "Paid in full", "Tuition due (NGN)": 34450, "Tuition paid (NGN)": 34450, "Balance (NGN)": 0 }],
    notPaid: [],
  });
  const files = unzipSync(buffer);
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const paidSheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const notPaidSheet = strFromU8(files["xl/worksheets/sheet2.xml"]);

  assert.match(workbook, /name="Paid in full"/);
  assert.match(workbook, /name="Not paid in full"/);
  assert.match(paidSheet, /<t xml:space="preserve">Ada Okafor<\/t>/);
  assert.match(paidSheet, /<v>34450<\/v>/);
  assert.match(notPaidSheet, /<t xml:space="preserve">Student name<\/t>/);
});
