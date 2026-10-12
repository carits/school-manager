/** Existing PDF answer sheets: durable imports, explicit ownership and score-only review. */
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import { requireExamAccess, isPrivilegedGrader, isTeacherPermittedForExam } from "../../apps/answer-card/server/middleware";
import { requestUploadBudget } from "../lib/uploadBudget";
import { submitReviewCropScores } from "../services/ReviewService";
import { ReviewPoolError } from "../services/ReviewPoolService";
import { WEEK7_CHINESE_TEMPLATE } from "../../shared/externalPaperPreset";
import { externalBlockId, type ExternalPageResult, type ExternalTemplate } from "../../shared/externalPaper";
import { configureExternalExam, confirmExternalSheet, confirmExternalAnswer, getExternalConfig, saveExternalKey, saveExternalAssignments, paperError, type ExternalSheetRow, type ExternalConfigRow } from "../services/externalPaper/core";
import { enqueueExternalPdf, type ExternalBatchRow, type ExternalPageRow } from "../services/externalPaper/worker";
import { assertExternalReviewScope, claimExternalPaper, scoreOnlyView, EXTERNAL_CLAIM_MS, type ScoreOnlyCrop } from "../services/externalPaper/review";
import { batchDirectory, childPath, externalRoot, EXTERNAL_MAX_PDF_BYTES, templateDirectory } from "../services/externalPaper/files";

const router = Router();
const db = () => getMysqlDb();
const id = (value: unknown): number => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) paperError("考试或题号无效", 422); return n; };
const manager: RequestHandler = (req, res, next) => {
  if (!isPrivilegedGrader(req.user)) { res.status(403).json({ message: "扫描管理及分工仅限管理员或学年主任" }); return; }
  next();
};
const read = requirePermission(PERMISSIONS.GRADE_READ), write = requirePermission(PERMISSIONS.GRADE_WRITE);
router.use(authMiddleware);
router.get("/preset/week7", read, manager, (_req, res) => res.json(WEEK7_CHINESE_TEMPLATE));
router.use("/exams/:examId", requireExamAccess);
const upload = multer({ storage: multer.diskStorage({
  destination: async (_req, _file, cb) => { try { const dir = childPath(externalRoot, "incoming"); await mkdir(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e as Error, ""); } },
  filename: (_req, _file, cb) => cb(null, `${randomUUID()}.pdf`)
}), limits: { fileSize: EXTERNAL_MAX_PDF_BYTES, files: 1, fields: 4, fieldSize: 512 * 1024 } });
const budget = requestUploadBudget({ maxTotalBytes: EXTERNAL_MAX_PDF_BYTES + 1024 * 1024, label: "扫描 PDF 上传" });
const viewBatch = (b: ExternalBatchRow) => ({ id: b.id, name: b.original_name, status: b.status, pageCount: b.page_count, finished: b.finished, error: b.error_text });
async function ownedBatch(examId: number, batchId: string) {
  return await db().get<ExternalBatchRow>("SELECT * FROM external_paper_batches WHERE id=? AND exam_id=?", batchId, examId) ?? paperError("扫描批次不存在", 404);
}
async function scopedCrop(req: any): Promise<ScoreOnlyCrop> {
  const row = await db().get<ScoreOnlyCrop>("SELECT * FROM answer_block_crops WHERE id=? AND exam_id=?", String(req.params.cropId), id(req.params.examId));
  if (!row || !row.block_id.startsWith(`external_${id(req.params.examId)}_`)) paperError("答题图片不存在", 404);
  await assertExternalReviewScope(db(), row, req.user.id, isPrivilegedGrader(req.user));
  return row;
}
router.get("/exams/:examId/status", read, manager, async (req, res) => {
  const examId = id(req.params.examId);
  const config = await db().get<ExternalConfigRow>("SELECT * FROM external_paper_exams WHERE exam_id=?", examId);
  if (!config) { res.json({ configured: false }); return; }
  const batches = await db().all<ExternalBatchRow>("SELECT * FROM external_paper_batches WHERE exam_id=? ORDER BY created_at DESC LIMIT 100", examId);
  const counts = await db().get("SELECT COUNT(*) AS total,SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END) AS reviewed FROM answer_block_crops WHERE exam_id=?", examId);
  const classes = await db().all("SELECT DISTINCT c.id,c.name FROM classes c JOIN exam_class_memberships m ON m.class_id=c.id WHERE m.exam_id=? ORDER BY c.name", examId);
  res.json({ configured: true, classes, template: JSON.parse(config.template_json), answerKey: JSON.parse(config.answer_key_json), assignments: JSON.parse(config.assignments_json), batches: batches.map(viewBatch), counts });
});
router.post("/exams/:examId/template", write, manager, budget, upload.single("file"), async (req, res) => {
  if (!req.file) paperError("请上传空白答题卡 PDF", 422);
  try {
    let value: unknown;
    try { value = JSON.parse(String(req.body.template ?? "null")); } catch { paperError("模板设置不是有效 JSON", 422); }
    await configureExternalExam(id(req.params.examId), value, req.file.path, req.user!.id);
    res.json({ ok: true });
  } finally { await rm(req.file.path, { force: true }).catch(() => {}); }
});
router.get("/exams/:examId/template/:page/image", read, manager, async (req, res) => {
  const examId = id(req.params.examId), config = await getExternalConfig(examId);
  const page = id(req.params.page), template = JSON.parse(config.template_json) as ExternalTemplate;
  if (!template.pages.some(p => p.number === page)) paperError("页码不存在", 404);
  res.setHeader("Cache-Control", "private, no-store"); res.sendFile(childPath(templateDirectory(examId, config.template_hash), `page-${page}.png`));
});
router.post("/exams/:examId/pdf", write, manager, budget, upload.single("file"), async (req, res) => {
  if (!req.file) paperError("请上传扫描 PDF", 422);
  try {
    let name = req.file.originalname;
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (Buffer.from(decoded).toString("latin1") === name) name = decoded;
    const row = await enqueueExternalPdf(id(req.params.examId), req.file.path, name, req.user!.id);
    res.status(202).json(viewBatch(row));
  } finally { await rm(req.file.path, { force: true }).catch(() => {}); }
});
router.get("/exams/:examId/batches/:batchId", read, manager, async (req, res) => {
  const batch = await ownedBatch(id(req.params.examId), String(req.params.batchId));
  const pages = await db().all<ExternalPageRow>("SELECT * FROM external_paper_pages WHERE batch_id=? ORDER BY page_index", batch.id);
  res.json({ ...viewBatch(batch), pages: pages.map(p => { const r = JSON.parse(p.result_json) as ExternalPageResult; return { id: p.id, index: p.page_index, sheetId: p.paper_id, status: r.status, pageNumber: r.pageNumber, studentNumber: r.studentNumber, identityCertain: r.identityCertain, quality: r.quality, message: r.message, observations: r.questions }; }) });
});
router.get("/exams/:examId/batches/:batchId/pages/:page/image", read, manager, async (req, res) => {
  const batch = await ownedBatch(id(req.params.examId), String(req.params.batchId)), page = id(req.params.page);
  if (page > batch.page_count) paperError("扫描页不存在", 404);
  const dir = childPath(batchDirectory(batch.exam_id, batch.id), `page-${page}`);
  let file = childPath(dir, "aligned.png");
  if (req.query.original === "1") file = childPath(dir, "source.png");
  else { try { await access(file); } catch { file = childPath(dir, "source.png"); } }
  res.setHeader("Cache-Control", "private, no-store"); res.sendFile(file);
});
router.post("/exams/:examId/batches/:batchId/retry", write, manager, async (req, res) => {
  const examId = id(req.params.examId), batchId = String(req.params.batchId);
  await db().transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const b = await tx.get<{ status: string; lease_until: number }>("SELECT status,lease_until FROM external_paper_batches WHERE exam_id=? AND id=?", examId, batchId);
    if (!b) paperError("扫描批次不存在", 404);
    if (b.status === "processing" && Number(b.lease_until) > Date.now()) paperError("本批次仍在处理中");
    const pages = await tx.all<ExternalPageRow>("SELECT * FROM external_paper_pages WHERE batch_id=?", batchId);
    for (const p of pages) if (!p.paper_id && JSON.parse(p.result_json).status !== "ok") await tx.run("DELETE FROM external_paper_pages WHERE id=? AND paper_id IS NULL", p.id);
    await tx.run("UPDATE external_paper_batches SET status='queued',worker_token=NULL,lease_until=0,error_text=NULL WHERE id=?", batchId);
  });
  res.json({ ok: true });
});
router.post("/exams/:examId/sheets", write, manager, async (req, res) => {
  if (req.body?.confirmed !== true) paperError("请先核对正反面配对与考号，再确认归属", 422);
  const sheetId = await confirmExternalSheet(id(req.params.examId), req.body.pageIds, String(req.body.studentNumber ?? ""), req.user!.id, req.body.existingSheetId ? String(req.body.existingSheetId) : undefined);
  res.json({ ok: true, sheetId });
});
router.get("/exams/:examId/sheets", read, manager, async (req, res) => {
  const examId = id(req.params.examId), offset = Math.max(0, Math.min(100000, Math.floor(Number(req.query.offset) || 0)));
  const rows = await db().all<ExternalSheetRow & { total_score: number | null }>("SELECT p.*,s.total_score FROM external_paper_sheets p JOIN student_scores s ON s.exam_id=p.exam_id AND s.student_id=p.student_id WHERE p.exam_id=? ORDER BY p.student_number LIMIT 100 OFFSET ?", examId, offset);
  const result = [];
  for (const r of rows) {
    const scores = await db().all("SELECT question_number AS number,score_type AS type,score,max_score AS maxScore FROM question_scores WHERE exam_id=? AND student_id=? ORDER BY question_number", examId, r.student_id);
    const pages = await db().all<ExternalPageRow>("SELECT * FROM external_paper_pages WHERE paper_id=? ORDER BY page_index", r.id);
    result.push({ id: r.id, studentNumber: r.student_number, version: r.version, observations: JSON.parse(r.observations_json), total: r.total_score, scores, pages: pages.map(p => ({ id: p.id, batchId: p.batch_id, index: p.page_index, pageNumber: JSON.parse(p.result_json).pageNumber })) });
  }
  const count = await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM external_paper_sheets WHERE exam_id=?", examId);
  res.json({ rows: result, count: Number(count?.n ?? 0), offset });
});
router.put("/exams/:examId/answers", write, manager, async (req, res) => { await saveExternalKey(id(req.params.examId), req.body, req.user!.id); res.json({ ok: true }); });
router.put("/exams/:examId/sheets/:sheetId/answers/:question", write, manager, async (req, res) => {
  await confirmExternalAnswer(id(req.params.examId), String(req.params.sheetId), id(req.params.question), req.body.options, req.body.version, req.user!.id); res.json({ ok: true });
});
router.put("/exams/:examId/assignments", write, manager, async (req, res) => {
  const examId = id(req.params.examId);
  if (!req.body || Array.isArray(req.body) || typeof req.body !== "object") paperError("分工格式无效", 422);
  const teachers = new Set<number>();
  for (const rule of Object.values(req.body) as any[]) if (Array.isArray(rule?.teacherIds)) for (const n of rule.teacherIds) teachers.add(n);
  if (teachers.size > 100) paperError("本场最多分配 100 位教师", 422);
  for (const teacherId of teachers) if (!Number.isSafeInteger(teacherId) || !await isTeacherPermittedForExam(examId, teacherId, "can_assign")) paperError("包含未获授权的阅卷教师", 403);
  await saveExternalAssignments(examId, req.body, req.user!.id); res.json({ ok: true });
});
router.post("/exams/:examId/questions/:question/claim", write, async (req, res) => {
  try { res.json({ current: await claimExternalPaper(id(req.params.examId), id(req.params.question), req.user!.id, isPrivilegedGrader(req.user), db(), typeof req.body?.excludeCropId === "string" ? req.body.excludeCropId.slice(0,64) : undefined) }); }
  catch (error) { if (error instanceof ReviewPoolError) { res.json({ current: null, message: error.message }); return; } throw error; }
});
router.get("/exams/:examId/questions/:question/history", read, async (req, res) => {
  const examId = id(req.params.examId), config = await getExternalConfig(examId), template = JSON.parse(config.template_json) as ExternalTemplate;
  const crops = await db().all<ScoreOnlyCrop>("SELECT * FROM answer_block_crops WHERE exam_id=? AND block_id=? AND reviewer_id=? AND status='reviewed' ORDER BY reviewed_at DESC LIMIT 30", examId, externalBlockId(examId, id(req.params.question)), req.user!.id);
  const result = [];
  for (const crop of crops) { try { await assertExternalReviewScope(db(), crop, req.user!.id, isPrivilegedGrader(req.user)); result.push(scoreOnlyView(crop, template)); } catch { /* revoked assignments are not readable */ } }
  res.json({ rows: result });
});
router.get("/exams/:examId/crops/:cropId/image", read, async (req, res) => {
  const crop = await scopedCrop(req);
  if (!path.resolve(crop.image_path).startsWith(path.resolve(externalRoot) + path.sep)) paperError("图片来源无效");
  res.setHeader("Cache-Control", "private, no-store"); res.sendFile(path.resolve(crop.image_path));
});
for (const action of ["heartbeat", "release"] as const) router.post(`/exams/:examId/crops/:cropId/${action}`, write, async (req, res) => {
  const crop = await scopedCrop(req);
  if (!Number.isSafeInteger(req.body?.claimCount)) paperError("领取凭据无效", 422);
  const updated = await db().run(`UPDATE answer_block_crops SET ${action === "release" ? "claimed_by=NULL,claimed_at=NULL" : "claimed_at=?"} WHERE id=? AND exam_id=? AND claimed_by=? AND claim_count=? AND status='ready' AND claimed_at >= ?`, ...(action === "release" ? [] : [databaseTimestamp()]), crop.id, crop.exam_id, req.user!.id, req.body.claimCount, databaseTimestamp(new Date(Date.now() - EXTERNAL_CLAIM_MS)));
  if (!updated.changes) paperError("领取已失效，请重新领取");
  res.json({ ok: true });
});
router.post("/exams/:examId/crops/:cropId/score", write, async (req, res) => {
  const crop = await scopedCrop(req), config = await getExternalConfig(crop.exam_id), template = JSON.parse(config.template_json) as ExternalTemplate;
  const q = template.questions.find(q => externalBlockId(crop.exam_id, q.number) === crop.block_id)!;
  res.json(await submitReviewCropScores({ examId: crop.exam_id, cropId: crop.id, userId: req.user!.id,
    blockTotalScore: req.body.score, scores: [{ questionNumber: q.number, scoreType: "subjective", score: req.body.score }],
    requestId: req.body.requestId, claimCount: req.body.claimCount, editRound: req.body.editRound, isAdmin: isPrivilegedGrader(req.user) }));
});
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
router.get("/exams/:examId/export", read, manager, async (req, res) => {
  const examId = id(req.params.examId), t = JSON.parse((await getExternalConfig(examId)).template_json) as ExternalTemplate;
  const students = await db().all<{ student_id: number; student_number: string; name: string; total_score: number | null }>("SELECT ep.student_id,u.student_number,u.name,ss.total_score FROM exam_participants ep JOIN users u ON u.id=ep.student_id LEFT JOIN student_scores ss ON ss.exam_id=ep.exam_id AND ss.student_id=ep.student_id WHERE ep.exam_id=? ORDER BY u.student_number", examId);
  const questions = [...t.questions].sort((a, b) => a.number - b.number);
  const lines = [["考号", "姓名", ...questions.map(q => `第${q.number}题`), "正式总分", "状态"].map(csvCell).join(",")];
  for (const s of students) {
    const scores = await db().all<{ question_number: number; score_type: string; score: number | null }>("SELECT question_number,score_type,score FROM question_scores WHERE exam_id=? AND student_id=?", examId, s.student_id);
    lines.push([s.student_number, s.name, ...questions.map(q => scores.find(r => Number(r.question_number) === q.number && r.score_type === q.type)?.score ?? null), s.total_score, s.total_score == null ? "未完成" : "已完成"].map(csvCell).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", `attachment; filename="external-exam-${examId}.csv"`); res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
});
router.use((error: any, _req: any, res: any, _next: any) => {
  if (res.headersSent) return _next(error);
  if (error?.code === "ENOENT") return res.status(404).json({ message: "图片尚未生成或已缺失，请重试扫描批次" });
  const status = error?.name === "MulterError" ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 422) : (Number.isInteger(error?.status) ? error.status : 422);
  res.status(status >= 400 && status < 600 ? status : 500).json({ message: error instanceof Error ? error.message : "操作未完成" });
});
export default router;
