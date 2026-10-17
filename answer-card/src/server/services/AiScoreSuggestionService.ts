import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { getMysqlDb } from "../db";
import { getAssignedStudentIdSet, isClaimableForAssignedSet } from "./ReviewPoolService";
import type { Request } from "express";

type Row = Record<string, any>;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const cachedImages = new Map<string, { stamp: string; hash: string }>();
export const AI_SUGGESTION_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS legacy_ai_score_suggestions(id VARCHAR(64) PRIMARY KEY,exam_id INT NOT NULL,paper_id VARCHAR(64) NOT NULL,serial_no INT NOT NULL,crop_id VARCHAR(64) NOT NULL,question_number INT NOT NULL,status VARCHAR(24) NOT NULL,score DOUBLE NOT NULL,max_score DOUBLE NOT NULL,answer_text LONGTEXT NOT NULL,reason LONGTEXT NOT NULL,rubric_version VARCHAR(64) NOT NULL,rubric_hash CHAR(64) NOT NULL,input_json LONGTEXT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY current_suggestion(crop_id),KEY exam_serial(exam_id,serial_no))",
  "CREATE TABLE IF NOT EXISTS legacy_ai_score_adoptions(id BIGINT AUTO_INCREMENT PRIMARY KEY,suggestion_id VARCHAR(64) NOT NULL,actor_id INT NOT NULL,crop_id VARCHAR(64) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY suggestion_actor(suggestion_id,actor_id))"
];
let schema: Promise<void> | undefined;
export function ensureAiSuggestionSchema() {
  if (process.env.PROJECTX_LEGACY_ONLY !== "1") throw fail(404, "入口不存在");
  if (!schema) schema = (async () => {
    for (const sql of AI_SUGGESTION_SCHEMA) await getMysqlDb().exec(sql);
  })().catch(error => { schema = undefined; throw error; });
  return schema;
}
async function imageHash(path: string) {
  const meta = await stat(path), stamp = meta.size + ":" + meta.mtimeMs + ":" + meta.ctimeMs;
  const old = cachedImages.get(path);
  if (old?.stamp === stamp) return old.hash;
  const value = hash(await readFile(path));
  cachedImages.set(path, {stamp, hash: value});
  if (cachedImages.size > 128) cachedImages.delete(cachedImages.keys().next().value!);
  return value;
}
export async function authorizedAiCrop(req: Request) {
  await ensureAiSuggestionSchema();
  const db = getMysqlDb(), examId = Number(req.params.examId);
  const crop = await db.get<Row>(
    "SELECT c.id,c.exam_id,c.block_id,c.student_id,c.claimed_by,c.status,c.review_round,m.paper_id,m.version formal_version,m.score formal_score,p.batch_id,s.serial_no,b.template_id,t.definition_json FROM answer_block_crops c JOIN legacy_pdf_marks m ON m.crop_id=c.id JOIN legacy_pdf_papers p ON p.id=m.paper_id JOIN legacy_paper_serials s ON s.paper_id=p.id JOIN legacy_pdf_batches b ON b.id=p.batch_id JOIN legacy_pdf_templates t ON t.id=b.template_id WHERE c.id=? AND c.exam_id=?",
    String(req.params.cropId), examId);
  if (!crop) throw fail(404, "试卷题目不存在");
  if (!req.user) throw fail(401, "未登录");
  const privileged = Number(req.user.role_id) === 1 || req.user.teacher_role === "grade_leader";
  if (!privileged) {
    const assigned = await getAssignedStudentIdSet(examId, crop.block_id, Number(req.user.id));
    if (Number(crop.claimed_by) !== Number(req.user.id) &&
      !isClaimableForAssignedSet({studentId: crop.student_id, status: crop.status, reviewRound: crop.review_round}, assigned)) {
      throw fail(403, "未分配该学生卷");
    }
  }
  return {crop, privileged};
}
export async function readAiSuggestion(crop: Row) {
  const db = getMysqlDb();
  const row = await db.get<Row>("SELECT * FROM legacy_ai_score_suggestions WHERE crop_id=? AND exam_id=? AND status='completed'", crop.id, crop.exam_id);
  if (!row) return null;
  const input = JSON.parse(row.input_json);
  if (row.paper_id !== crop.paper_id || Number(row.serial_no) !== Number(crop.serial_no) ||
    input.templateId !== crop.template_id || input.definitionHash !== hash(crop.definition_json)) return null;
  const key = await db.get<Row>("SELECT answer_text FROM exam_answer_keys WHERE exam_id=? AND question_number=?", crop.exam_id, row.question_number);
  if (hash(String(key?.answer_text || "")) !== row.rubric_hash) return null;
  const pages = await db.all<Row>("SELECT id,page_role,aligned_path,version,status FROM legacy_pdf_pages WHERE paper_id=? ORDER BY id", crop.paper_id);
  if (pages.length !== input.pages.length) return null;
  for (const p of pages) {
    const original = input.pages.find((v: Row) => v.id === p.id);
    if (!original || original.role !== p.page_role || original.version !== Number(p.version) ||
      p.status !== "recognized" || original.path !== p.aligned_path ||
      original.hash !== await imageHash(p.aligned_path)) return null;
  }
  if (!Number.isFinite(Number(row.score)) || row.score < 0 || row.score > row.max_score) return null;
  return { id: row.id, status: "completed" as const, questionNumber: Number(row.question_number),
    score: Number(row.score), maxScore: Number(row.max_score), answerText: row.answer_text,
    reason: row.reason, rubricVersion: row.rubric_version, createdAt: row.created_at };
}
export async function adoptAiDraft(req: Request) {
  const {crop, privileged} = await authorizedAiCrop(req);
  if (!privileged && Number(crop.claimed_by) !== Number(req.user!.id)) throw fail(409, "请先打开已领取的试卷");
  const suggestion = await readAiSuggestion(crop);
  if (!suggestion || suggestion.id !== req.body?.suggestionId) throw fail(409, "AI建议已失效，请刷新后重新核对");
  // Explicit adoption fills the teacher's draft only. Formal scoring remains the normal teacher submission.
  await getMysqlDb().run("INSERT INTO legacy_ai_score_adoptions(suggestion_id,actor_id,crop_id) VALUES(?,?,?)",
    suggestion.id, req.user!.id, crop.id);
  return { suggestion, formalScoreWritten: false };
}
