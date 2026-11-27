import { strToU8, zipSync } from "fflate";

const classGroups = [
  ["reception"],
  ["kg1"],
  ["kg2"],
  ["nur1"],
  ["nur2"],
  ["basic1"],
  ["basic2"],
  ["basic3", "basic34", "basic4"],
  ["basic5"],
  ["jss1"],
  ["jss2"],
  ["jss3"],
  ["ss1"],
  ["ss2"],
  ["ss3"],
];
const classOrder = new Map(classGroups.flatMap((group, rank) =>
  group.map((classKey) => [classKey, rank])));

const rosterTuitionRates = {
  jss1: 36300,
  jss2: 36300,
  jss3: 46000,
  ss1: 37300,
  ss2: 37300,
  ss3: 40500,
};

export function getCategoryFeeItems(summary) {
  const pattern = /(?:(\d+(?:\.\d+)?)\s*x\s+)?(tuition|lesson|social)\s+fee\b/gi;
  return [...String(summary ?? "").matchAll(pattern)].map((match) => ({
    category: match[2].toLocaleLowerCase(),
    quantity: match[1] ? Number(match[1]) : 1,
  }));
}

export function getTuitionPaymentAmount(record, tuitionRate) {
  if (!Number.isFinite(tuitionRate) || tuitionRate <= 0) return 0;
  const tuitionQuantity = getCategoryFeeItems(record.itemsSummary)
    .filter(({ category }) => category === "tuition")
    .reduce((total, item) => total + item.quantity, 0);
  if (tuitionQuantity <= 0) return 0;

  const rawAmount = record.total;
  const amount = typeof rawAmount === "number"
    ? rawAmount
    : Number(String(rawAmount ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(amount, tuitionRate * tuitionQuantity);
}

export function tuitionStudentKey(record, classKeyForRecord) {
  const name = String(record.studentName ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const classKey = classKeyForRecord(record.class);
  if (!name || !classKey) return null;
  return `${name}|${classKey}`;
}

export function normalizeStudentName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function sortRecordsByClass(records, classKeyForRecord) {
  return [...records].sort((left, right) => {
    const leftClass = String(left.class ?? "");
    const rightClass = String(right.class ?? "");
    const leftRank = classOrder.get(classKeyForRecord(leftClass)) ?? classGroups.length;
    const rightRank = classOrder.get(classKeyForRecord(rightClass)) ?? classGroups.length;
    return leftRank - rightRank ||
      leftClass.localeCompare(rightClass, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function createTuitionExportSheets(records, statuses, classKeyForRecord, examNumbers = new Map(), roster = []) {
  const sourceRecords = new Map();
  roster.forEach((student) => {
    const record = {
      studentName: student.name,
      class: student.className,
      parentEmail: "",
    };
    const key = tuitionStudentKey(record, classKeyForRecord);
    if (key) sourceRecords.set(key, record);
  });
  records.forEach((record) => {
    const key = tuitionStudentKey(record, classKeyForRecord);
    if (!key) return;
    const rosterRecord = sourceRecords.get(key);
    if (rosterRecord) {
      if (!rosterRecord.parentEmail && record.parentEmail) {
        rosterRecord.parentEmail = String(record.parentEmail).trim();
      }
      return;
    }
    sourceRecords.set(key, record);
  });

  const students = new Map();
  sourceRecords.forEach((record, key) => {
    const tuition = statuses.get(key) || {
      state: roster.length ? "unpaid" : "unavailable",
      paid: 0,
      rate: rosterTuitionRates[classKeyForRecord(record.class)],
    };
    const labels = {
      complete: "Paid in full",
      partial: "Partially paid",
      unpaid: "Unpaid",
      unavailable: "Needs review",
    };
    const rate = Number.isFinite(tuition.rate) ? tuition.rate : null;
    const paid = Number.isFinite(tuition.paid) ? tuition.paid : 0;
    students.set(key, {
      "Student name": String(record.studentName ?? "").trim(),
      Class: String(record.class ?? "").trim(),
      "Parent email": String(record.parentEmail ?? "").trim(),
      Status: labels[tuition.state] || labels.unavailable,
      "Tuition due (NGN)": rate,
      "Tuition paid (NGN)": paid,
      "Balance (NGN)": rate === null ? null : Math.max(rate - paid, 0),
      state: tuition.state,
      key,
    });
  });

  const allStudents = [...students.values()];
  const toRow = ({ state, key, ...row }) => ({
    ...row,
    "Exam number": examNumbers.get(key) || "",
  });
  return {
    paid: allStudents.filter(({ state }) => state === "complete").map(toRow),
    notPaid: allStudents.filter(({ state }) => state !== "complete").map(toRow),
  };
}

const baseColumns = [
  { header: "Student name", key: "Student name", width: 28 },
  { header: "Class", key: "Class", width: 16 },
  { header: "Parent email", key: "Parent email", width: 32 },
  { header: "Status", key: "Status", width: 20 },
  { header: "Tuition due (NGN)", key: "Tuition due (NGN)", width: 20 },
  { header: "Tuition paid (NGN)", key: "Tuition paid (NGN)", width: 21 },
  { header: "Balance (NGN)", key: "Balance (NGN)", width: 18 },
  { header: "Exam number", key: "Exam number", width: 18 },
];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellXml(reference, value, style = "") {
  const styleAttribute = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  }
  if (value === null || value === undefined || value === "") {
    return `<c r="${reference}"${styleAttribute}/>`;
  }
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function worksheetXml(rows, headerStyle, sheetColumns) {
  const headerCells = sheetColumns.map((column, index) =>
    cellXml(`${columnName(index)}1`, column.header, headerStyle)).join("");
  const dataRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = sheetColumns.map((column, index) => {
      const style = column.key.endsWith("(NGN)") ? "3" : "";
      if (
        column.key === "Balance (NGN)" &&
        Number.isFinite(row["Tuition due (NGN)"]) &&
        Number.isFinite(row["Tuition paid (NGN)"])
      ) {
        return `<c r="${columnName(index)}${rowNumber}" s="${style}"><f>MAX(E${rowNumber}-F${rowNumber},0)</f><v>${row[column.key]}</v></c>`;
      }
      return cellXml(`${columnName(index)}${rowNumber}`, row[column.key], style);
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const widths = sheetColumns.map((column, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join("");
  const lastRow = rows.length + 1;
  const lastColumn = columnName(sheetColumns.length - 1);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<cols>${widths}</cols><sheetData><row r="1" ht="24" customHeight="1">${headerCells}</row>${dataRows}</sheetData>
<autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`;
}

export function createTuitionWorkbook({ paid, notPaid }) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="Paid in full" sheetId="1" r:id="rId1"/><sheet name="Not paid in full" sheetId="2" r:id="rId2"/></sheets>
<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;NGN&quot; #,##0.00"/></numFmts>
<fonts count="2"><font><name val="Calibri"/><sz val="11"/></font><font><name val="Calibri"/><b/><color rgb="FFFFFFFF"/><sz val="11"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E7D4A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFB36B00"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    "xl/worksheets/sheet1.xml": worksheetXml(paid, "1", baseColumns),
    "xl/worksheets/sheet2.xml": worksheetXml(notPaid, "2", baseColumns),
  };
  return zipSync(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
  ));
}
