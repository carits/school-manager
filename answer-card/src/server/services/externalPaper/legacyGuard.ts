import type { RequestHandler } from "express";
import { getMysqlDb } from "../../db";
/** Prevent older destructive/import/review endpoints from bypassing the frozen external-paper workflow. */
export const externalPaperLegacyGuard: RequestHandler = async (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/external-paper/") || !req.user) { next(); return; }
  const db = getMysqlDb();
  const examMatch = req.path.match(/^\/(?:exams|review(?:-assign|-arbitration|-annotations|-pool|-session)?\/exams|block-grading-config\/exams)\/(\d+)(?:\/|$)/);
  const examId = examMatch ? Number(examMatch[1]) : null;
  let isExternal = examId ? !!await db.get("SELECT 1 FROM external_paper_exams WHERE exam_id=?", examId) : false;
  const cardId = req.body?.cardId ?? req.body?.card_id;
  if (typeof cardId === "string" && await db.get("SELECT 1 FROM external_paper_exams WHERE card_id=?", cardId)) isExternal = true;
  if (!isExternal && req.method === "DELETE" && /^\/review-assign\/\d+$/.test(req.path)) {
    const row = await db.get<{ block_id: string }>("SELECT block_id FROM review_assignments WHERE id=?", Number(req.path.split("/").pop()));
    isExternal = !!row?.block_id.startsWith("external_");
  }
  if (!isExternal) { next(); return; }
  // Existing publication and explicit roster-management remain available. Scoring/geometry use one path only.
  const tail = examId ? req.path.replace(`/exams/${examId}`, "") : "";
  if (examId && req.path.startsWith("/exams/") && ["/publish", "/unpublish", "/participants"].includes(tail)) { next(); return; }
  if (examId && req.path === `/exams/${examId}` && req.method === "PATCH" && Object.keys(req.body ?? {}).every(k => ["name", "mode", "showOriginalPaper"].includes(k))) { next(); return; }
  res.status(409).json({ message: "这场考试使用现成答题卡，请在扫描阅卷或只打分页面操作；不会通过旧入口覆盖已确认的模板、分工或成绩。" });
};
