import { getMysqlDb, type DbAdapter } from "../../db";
import { databaseTimestamp } from "../../db/timestamp";
import { assertScoreOnly, externalBlockId, type ExternalTemplate } from "../../../shared/externalPaper";
import type { ReviewSubmitResult } from "../../../shared/types";
import { markScoreMutated } from "../examPublishEvents";
import { ReviewPoolError, countHeldPapers } from "../ReviewPoolService";
import { MAX_HELD_PAPERS_TOTAL } from "../../../shared/reviewPoolLimits";
import { getExternalConfig, paperError, recomputeExternalStudent } from "./core";
import { hashText } from "./files";
export interface ScoreOnlyCrop { id: string; exam_id: number; student_id: number; block_id: string; claimed_by: number | null; claimed_at: string | null; claim_count: number; reviewer_id: number | null; review_round: number; status: string; final_score: number | null; score_breakdown: string | null; image_path: string }
export const EXTERNAL_CLAIM_MS = 5 * 60 * 1000;
export async function assertExternalReviewScope(db: DbAdapter, crop: Pick<ScoreOnlyCrop, "exam_id" | "block_id" | "student_id">, teacherId: number, privileged: boolean): Promise<void> {
  if (privileged) return;
  const row = await db.get<{ assigned_student_ids: string | null }>("SELECT assigned_student_ids FROM review_assignments WHERE exam_id=? AND block_id=? AND teacher_id=?", crop.exam_id, crop.block_id, teacherId);
  let ids: unknown;
  try { ids = JSON.parse(row?.assigned_student_ids ?? "null"); } catch { ids = null; }
  if (!Array.isArray(ids) || !ids.includes(crop.student_id)) paperError("该答卷不在你的阅卷分工内", 403);
}
export function scoreOnlyView(crop: ScoreOnlyCrop, template: ExternalTemplate) {
  const q = template.questions.find(q => externalBlockId(crop.exam_id, q.number) === crop.block_id);
  if (!q) paperError("题目不属于本卷");
  return { id: crop.id, questionNumber: q.number, maxScore: q.maxScore, step: q.step, claimCount: crop.claim_count, reviewRound: crop.review_round, score: crop.final_score, status: crop.status };
}
export async function claimExternalPaper(examId: number, number: number, teacherId: number, privileged: boolean, db = getMysqlDb(), excludeCropId?: string) {
  // Use the same exam lock as reassignment and score submission. A claim cannot
  // appear between "no active papers" and removal of a teacher's assignment.
  return db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const config = await getExternalConfig(examId, tx), template = JSON.parse(config.template_json) as ExternalTemplate;
    if (!template.questions.some(q => q.number === number && q.type === "subjective")) paperError("题号不存在", 404);
    const block = externalBlockId(examId, number);
    const assignment = await tx.get<{ assigned_student_ids: string | null }>("SELECT assigned_student_ids FROM review_assignments WHERE exam_id=? AND block_id=? AND teacher_id=?", examId, block, teacherId);
    if (!privileged && !assignment) paperError("未分配该题", 403);
    let ids: number[] = [];
    try { const value: unknown = JSON.parse(assignment?.assigned_student_ids ?? "[]"); if (Array.isArray(value)) ids = value.filter(n => Number.isSafeInteger(n) && n > 0); } catch { /* fail closed */ }
    if (!privileged && !ids.length) throw new ReviewPoolError("该题当前没有分配给你的应考学生");
    await tx.run("UPDATE answer_block_crops SET claimed_by=NULL,claimed_at=NULL WHERE exam_id=? AND block_id=? AND status='ready' AND claimed_at < ?", examId, block, databaseTimestamp(new Date(Date.now() - EXTERNAL_CLAIM_MS)));
    let crop = await tx.get<ScoreOnlyCrop>("SELECT * FROM answer_block_crops WHERE exam_id=? AND block_id=? AND claimed_by=? AND status='ready' ORDER BY claimed_at LIMIT 1", examId, block, teacherId);
    if (!crop) {
      if (!privileged && (await countHeldPapers(teacherId, {examId,blockId:block}, tx)).total >= MAX_HELD_PAPERS_TOTAL) paperError("请先保存或释放其他已领取答卷");
      const slice = privileged ? "" : `AND student_id IN (${ids.map(() => "?").join(",")})`;
      crop = await tx.get<ScoreOnlyCrop>(`SELECT * FROM answer_block_crops WHERE exam_id=? AND block_id=? AND status='ready' AND claimed_by IS NULL ${slice} ${excludeCropId ? 'AND id<>?' : ''} ORDER BY student_number LIMIT 1`, examId, block, ...(privileged ? [] : ids), ...(excludeCropId ? [excludeCropId] : []));
      if (!crop) throw new ReviewPoolError("当前没有可领取答卷，后续补扫或其他教师释放后可再领取");
      const now = databaseTimestamp();
      const changed = await tx.run("UPDATE answer_block_crops SET claimed_by=?,claimed_at=?,claim_count=claim_count+1 WHERE id=? AND claimed_by IS NULL AND status='ready'", teacherId, now, crop.id);
      if (!changed.changes) throw new ReviewPoolError("答卷刚被领取，请重试");
      crop = {...crop, claimed_by: teacherId, claimed_at: now, claim_count: crop.claim_count + 1};
    }
    await assertExternalReviewScope(tx, crop, teacherId, privileged);
    return scoreOnlyView(crop, template);
  });
}

export interface ExternalScoreInput { examId: number; cropId: string; userId: number; score: unknown; requestId?: string; claimCount?: number; editRound?: number; isAdmin?: boolean }
/** Called by the shared ReviewService. No comments, no second grade store, no overwrite on retry. */
export async function submitExternalScore(input: ExternalScoreInput, db: DbAdapter = getMysqlDb()): Promise<ReviewSubmitResult> {
  if (!input.requestId || !/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId)) paperError("缺少有效的保存请求编号，请刷新阅卷页面", 422);
  const payloadHash = hashText(JSON.stringify([input.cropId, input.userId, input.score, input.claimCount ?? null, input.editRound ?? null]));
  return db.transactionWithNamedLock(`external-exam-${input.examId}`, 10000, async tx => {
    const crop = await tx.get<ScoreOnlyCrop>("SELECT * FROM answer_block_crops WHERE id=? AND exam_id=?", input.cropId, input.examId);
    if (!crop) paperError("答题图片不存在", 404);
    await assertExternalReviewScope(tx, crop, input.userId, input.isAdmin === true);
    const saved = await tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash,result_json FROM external_paper_requests WHERE exam_id=? AND id=?", input.examId, input.requestId);
    if (saved) {
      if (saved.payload_hash !== payloadHash) paperError("保存请求编号已被用于其他分数");
      return JSON.parse(saved.result_json) as ReviewSubmitResult;
    }
    const config = await getExternalConfig(input.examId, tx), template = JSON.parse(config.template_json) as ExternalTemplate;
    const question = template.questions.find(q => externalBlockId(input.examId, q.number) === crop.block_id && q.type === "subjective");
    if (!question) paperError("题目不在当前模板中");
    const score = assertScoreOnly(input.score, question.maxScore, question.step);
    if (input.editRound !== undefined) {
      if (crop.status !== "reviewed" || crop.review_round !== input.editRound || (!input.isAdmin && crop.reviewer_id !== input.userId)) paperError("已批分数已变化或不属于你，请刷新后再修改");
    } else if (crop.status !== "ready" || crop.claimed_by !== input.userId || crop.claim_count !== input.claimCount || !crop.claimed_at || crop.claimed_at < databaseTimestamp(new Date(Date.now() - EXTERNAL_CLAIM_MS))) {
      paperError("答卷领取已失效或已被批改，请重新领取；当前输入不会覆盖其他教师成绩");
    }
    const history: any[] = crop.score_breakdown ? JSON.parse(crop.score_breakdown) : [];
    const round = crop.review_round + 1;
    history.push({ round, reviewerId: input.userId, score, previousScore: crop.final_score, reviewedAt: databaseTimestamp(), requestId: input.requestId, questionScores: { [question.number]: score } });
    const changed = await tx.run("UPDATE answer_block_crops SET status='reviewed',claimed_by=NULL,claimed_at=NULL,reviewer_id=?,reviewed_at=?,review_round=?,final_score=?,score_breakdown=? WHERE id=? AND review_round=? AND claim_count=?", input.userId, databaseTimestamp(), round, score, JSON.stringify(history), crop.id, crop.review_round, crop.claim_count);
    if (!changed.changes) paperError("答卷状态已变更，未覆盖已有成绩");
    await markScoreMutated(tx, input.examId, input.userId, input.editRound === undefined ? "review_submit" : "score_edit");
    await tx.run("UPDATE question_scores SET score=?,manually_modified=1,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='subjective'", score, input.userId, databaseTimestamp(), input.examId, crop.student_id, question.number);
    const total = await recomputeExternalStudent(tx, input.examId, crop.student_id, template);
    const result: ReviewSubmitResult = { ok: true, cropId: crop.id, status: "reviewed", finalScore: score, reviewRound: round, totalScore: total };
    await tx.run("INSERT INTO external_paper_requests (exam_id,id,crop_id,actor_id,payload_hash,result_json) VALUES (?,?,?,?,?,?)", input.examId, input.requestId, crop.id, input.userId, payloadHash, JSON.stringify(result));
    return result;
  });
}
