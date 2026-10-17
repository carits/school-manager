import type { AnswerCard, SurveyMatrixConfig } from "../../shared/types";
import { surveyProfile } from "../../shared/cardPresets";
import { getMysqlDb } from "../db";

type RawQuestion = { questionNumber?: unknown; selectedOptions?: unknown; confidence?: unknown };
type RawRecognition = RawQuestion[] | { questions?: RawQuestion[] };

export type SurveyCellSummary = {
  questionNumber: number;
  row: string;
  column: string;
  A: number;
  B: number;
  C: number;
  blank: number;
  invalid: number;
  review: number;
  total: number;
};

export type SurveySummary = {
  sessionId: string;
  cardId: string;
  preset: "survey_matrix";
  formsScanned: number;
  formsAccepted: number;
  formsNeedReview: number;
  cells: SurveyCellSummary[];
  records: Array<{ recordId: string; status: "accepted" | "review" | "missing"; questionCount: number }>;
};

function asQuestions(value: string | null): RawQuestion[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as RawRecognition;
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.questions) ? parsed.questions : []);
  } catch { return []; }
}

function optionsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((option) => option === "A" || option === "B" || option === "C") : [];
}

export async function buildSurveySummary(card: AnswerCard, sessionId: string): Promise<SurveySummary> {
  const profile = surveyProfile(card);
  const cells = profile.rows.flatMap((row, rowIndex) => profile.columns.map((column, columnIndex) => ({
    questionNumber: rowIndex * profile.columns.length + columnIndex + 1,
    row, column, A: 0, B: 0, C: 0, blank: 0, invalid: 0, review: 0, total: 0,
  })));
  const byQuestion = new Map(cells.map((cell) => [cell.questionNumber, cell]));
  const rows = await getMysqlDb().all<{ id: string; objective_json: string | null }>(
    `SELECT r.id, x.objective_json
       FROM twain_scan_records r
       LEFT JOIN twain_recognition_results x ON x.scan_record_id = r.id
      WHERE r.session_id = ? ORDER BY r.page_num, r.side`, sessionId);
  const records: SurveySummary["records"] = [];
  for (const row of rows) {
    const questions = asQuestions(row.objective_json);
    let needsReview = questions.length !== cells.length;
    const seen = new Set<number>();
    for (const question of questions) {
      const number = Number(question.questionNumber);
      const cell = byQuestion.get(number);
      if (!cell || seen.has(number)) { needsReview = true; continue; }
      seen.add(number);
      const selected = optionsOf(question.selectedOptions);
      const confidence = Number(question.confidence);
      const lowConfidence = !Number.isFinite(confidence) || confidence < 0.12;
      cell.total += 1;
      if (selected.length === 1) cell[selected[0] as "A" | "B" | "C"] += 1;
      else if (selected.length === 0) cell.blank += 1;
      else cell.invalid += 1;
      if (lowConfidence || selected.length !== 1) { cell.review += 1; needsReview = true; }
    }
    if (seen.size !== cells.length) needsReview = true;
    records.push({ recordId: row.id, status: needsReview ? (questions.length ? "review" : "missing") : "accepted", questionCount: questions.length });
  }
  return {
    sessionId, cardId: card.id, preset: "survey_matrix",
    formsScanned: records.length,
    formsAccepted: records.filter((record) => record.status === "accepted").length,
    formsNeedReview: records.filter((record) => record.status !== "accepted").length,
    cells, records,
  };
}

export function surveySummaryWorkbook(summary: SurveySummary, profile: SurveyMatrixConfig) {
  const XLSX = require("xlsx") as typeof import("xlsx");
  const cellRows = summary.cells.map((cell) => ({
    题号: cell.questionNumber, 科目: cell.row, 评价维度: cell.column,
    A: cell.A, B: cell.B, C: cell.C, 空白: cell.blank, 多选或异常: cell.invalid,
    需复核: cell.review, 总数: cell.total,
  }));
  const recordRows = summary.records.map((record) => ({ 扫描记录: record.recordId, 状态: record.status, 识别题数: record.questionCount }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 扫描份数: summary.formsScanned, 完整通过: summary.formsAccepted, 需要复核: summary.formsNeedReview },
  ]), "统计");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cellRows), "题目统计");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(recordRows), "扫描记录");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
