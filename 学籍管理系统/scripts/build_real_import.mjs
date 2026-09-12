import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const sourcePath = "F:/xueji/中雅实验学校_仅保留735人.xlsx";
const templatePath = "F:/新生导入模板.xlsx";
const outputDir = "C:/Users/陈灿华/Documents/test/outputs/01a09005-5418-7352-acbd-61568c5e8c97";
const outputPath = `${outputDir}/中雅实验学校_735人学籍核对导入表.xlsx`;
const previewPath = `${outputDir}/学籍核对导入表预览.png`;

const source = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));
const sourceSheet = source.worksheets.getItem("学生基础信息");
const sourceValues = sourceSheet.getRange("A2:B736").values;
if (sourceValues.length !== 735) throw new Error(`Expected 735 source rows, got ${sourceValues.length}`);

const seenStudentIds = new Set();
const prepared = sourceValues.map((row, index) => {
  const nationalId = String(row[0] ?? "").trim().toUpperCase();
  const name = String(row[1] ?? "").trim();
  if (!/^G\d{17}[\dX]$/.test(nationalId)) throw new Error(`Invalid national student ID at source row ${index + 2}: type=${typeof row[0]}, length=${nationalId.length}, prefix=${nationalId.slice(0,1)}`);
  if (!name) throw new Error(`Missing name at source row ${index + 2}`);
  if (seenStudentIds.has(nationalId)) throw new Error(`Duplicate national student ID at source row ${index + 2}`);
  seenStudentIds.add(nationalId);
  const residentId = nationalId.slice(1);
  const birthDate = residentId.slice(6, 14);
  const gender = Number(residentId[16]) % 2 ? "男" : "女";
  return { nationalId, name, residentId, birthDate, gender };
});

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(templatePath));
const sheet = workbook.worksheets.getItem("新生1");
const oneColumn = (key) => prepared.map((item) => [item[key]]);
sheet.getRange("A2:A736").values = oneColumn("nationalId");
sheet.getRange("B2:B736").values = oneColumn("name");
sheet.getRange("C2:C736").values = oneColumn("gender");
sheet.getRange("D2:D736").values = oneColumn("birthDate");
sheet.getRange("H2:H736").values = prepared.map(() => ["中国"]);
sheet.getRange("I2:I736").values = prepared.map(() => ["居民身份证"]);
sheet.getRange("J2:J736").values = oneColumn("residentId");
sheet.getRange("K2:K736").values = prepared.map(() => ["非港澳台侨"]);
sheet.getRange("Y2:Y736").values = oneColumn("nationalId");
for (const address of ["A2:A736", "B2:B736", "D2:D736", "J2:J736", "Y2:Y736"]) {
  sheet.getRange(address).format.numberFormat = "@";
}
sheet.getRange("A:A").format.columnWidth = 24;
sheet.getRange("B:B").format.columnWidth = 13;
sheet.getRange("C:C").format.columnWidth = 8;
sheet.getRange("D:D").format.columnWidth = 13;
sheet.getRange("H:I").format.columnWidth = 18;
sheet.getRange("J:J").format.columnWidth = 23;
sheet.getRange("K:K").format.columnWidth = 16;
sheet.getRange("Y:Y").format.columnWidth = 24;
sheet.freezePanes.freezeRows(1);
sheet.freezePanes.freezeColumns(2);
workbook.recalculate();

const check = await workbook.inspect({
  kind: "table",
  sheetId: "新生1",
  range: "A1:Y6",
  include: "values,formulas",
  tableMaxRows: 6,
  tableMaxCols: 25,
  maxChars: 7000,
});
console.log(check.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 50 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "新生1", range: "A1:Y8", scale: 1, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewPath, rows: prepared.length }));
