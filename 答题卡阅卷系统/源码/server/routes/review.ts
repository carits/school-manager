/**
 * 网上阅卷 API
 * 挂载点: /api/review
 */
import { Router, type Request } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess, requireGradingScope, getPermittedBlocks, getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import { optionalPositiveNumber } from "../../apps/answer-card/server/helpers";
import {
  listReviewBlockCropItems,
  listReviewBlocks,
  submitReviewCropScores,
  ReviewValidationError
} from "../services/ReviewService";
import { getReviewTrace } from "../services/ReviewService";
import { buildAssignedSliceClause, type AssignedSliceClause } from "../services/ReviewPoolService";
import type { ReviewSubmitScoreInput } from "../../shared/types";
import { getMysqlDb } from "../db";

const router = Router();
// Old PDF exam progress is a separate read model; no recognition or score writes.
router.get("/processing-progress", requirePermission(PERMISSIONS.GRADE_READ), async (req,res,next)=>{
 try {
  if(process.env.PROJECTX_LEGACY_ONLY!=="1")return res.status(404).json({message:"入口不存在"});
  const raw=String(req.query.examIds||"").split(",").filter(Boolean);
  if(raw.length>100||raw.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<1))return res.status(400).json({message:"考试编号无效"});
  const visible=await getVisibleExamIds(req.user);
  const ids=[...new Set(raw.map(Number))].filter(id=>!visible||visible.includes(id));
  const {readExamPdfProgress}=await import("../services/ExamPdfProgressService");
  res.json({ok:true,data:await readExamPdfProgress(ids)});
 } catch(error){next(error);}
});
router.get("/exams/:examId/processing-progress",requireExamAccess,requirePermission(PERMISSIONS.GRADE_READ),async(req,res,next)=>{
 try{
  if(process.env.PROJECTX_LEGACY_ONLY!=="1")return res.status(404).json({message:"入口不存在"});
  const {readExamPdfProgress}=await import("../services/ExamPdfProgressService");
  res.json({ok:true,data:(await readExamPdfProgress([Number(req.params.examId)]))[0]});
 }catch(error){next(error);}
});
router.get("/exams/:examId/question-summary",requireExamAccess,requirePermission(PERMISSIONS.GRADE_READ),async(req,res,next)=>{
 try{
  if(process.env.PROJECTX_LEGACY_ONLY!=="1")return res.status(404).json({message:"入口不存在"});
  if(Number(req.user?.role_id)!==1&&req.user?.teacher_role!=="grade_leader")return res.status(403).json({message:"仅管理员或学年主任可查看全卷逐题汇总"});
  const page=Number(req.query.page||1),pageSize=Number(req.query.pageSize||50);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)return res.status(400).json({message:"分页参数无效"});
  const {examQuestionSummary}=await import("../services/ExamPdfProgressService");
  res.json({ok:true,data:await getMysqlDb().transaction(tx=>examQuestionSummary(Number(req.params.examId),{page,pageSize,search:String(req.query.search||"")},tx))});
 }catch(error){next(error);}
});

// Administrator view of each teacher's actual grading progress in the legacy PDF exam.
router.get("/exams/:examId/teacher-progress", requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ), async (req, res, next) => {
    try {
      if (process.env.PROJECTX_LEGACY_ONLY !== "1") return res.status(404).json({ message: "入口不存在" });
      const user = req.user;
      if (Number(user?.role_id) !== 1 && user?.teacher_role !== "grade_leader") {
        return res.status(403).json({ message: "仅管理员或学年主任可查看教师阅卷进度" });
      }
      const examId = Number(req.params.examId);
      const {readLegacyReviewGroupTeacherProgress}=await import("../services/LegacyReviewGroupService");
      const data = await getMysqlDb().transaction(async tx => {
      const groups=await readLegacyReviewGroupTeacherProgress(examId,tx);
      const rows = await tx.all<{
        teacherId: number; teacherName: string; blockId: string; blockTitle: string | null;
        allocatedCount: number; assignedCount: number; scoredCount: number; claimedCount: number;
      }>(
        `SELECT ra.teacher_id AS teacherId, u.name AS teacherName,
                ra.block_id AS blockId, MAX(c.block_title) AS blockTitle,
                MAX(ra.student_count) AS allocatedCount,
                COUNT(c.id) AS assignedCount,
                COALESCE(SUM(CASE WHEN c.status='reviewed'
                  AND m.score IS NOT NULL THEN 1 ELSE 0 END),0) AS scoredCount,
                COALESCE(SUM(CASE WHEN c.claimed_by=ra.teacher_id THEN 1 ELSE 0 END),0) AS claimedCount
         FROM review_assignments ra
         JOIN users u ON u.id=ra.teacher_id
         LEFT JOIN answer_block_crops c ON c.exam_id=ra.exam_id AND c.block_id=ra.block_id
           AND c.source_type='legacy_pdf' AND c.student_id IS NOT NULL
           AND JSON_CONTAINS(CASE WHEN JSON_VALID(ra.assigned_student_ids)
             THEN ra.assigned_student_ids ELSE '[]' END, CAST(c.student_id AS CHAR))
         LEFT JOIN legacy_pdf_marks m ON m.crop_id=c.id
         WHERE ra.exam_id=?
         GROUP BY ra.id,ra.teacher_id,u.name,ra.block_id
         ORDER BY u.name,ra.block_id`, examId);
      return [...rows.filter(row=>!groups.replacedBlockIds.has(row.blockId)).map(row => ({
        ...row,
        allocatedCount: Number(row.allocatedCount),
        assignedCount: Number(row.assignedCount),
        scoredCount: Number(row.scoredCount),
        claimedCount: Number(row.claimedCount),
      })),...groups.rows];
      });
      res.json({ ok: true, data });
    } catch (error) { next(error); }
  });


/**
 * 当前调用者在这些题块内的逐生切片条件（PR #312 评审 B1）。
 *
 * `permitted === null` 表示 `getPermittedBlocks` 判定的「整场不受题块限制」（管理员 /
 * 学年主任 / 没有权限矩阵），这类账号本来就读全卷，不额外收口；本地模式未强制鉴权时
 * 也没有 `req.user`，同样返回 null 保持既有行为。
 */
async function assignedSliceFor(
  user: Request["user"],
  examId: number,
  blockIds: string[] | null
): Promise<AssignedSliceClause | null> {
  if (!user || !blockIds) return null;
  return buildAssignedSliceClause(examId, Number(user.id), blockIds);
}

// Grading reference is exam-specific and restricted to the caller's grading block.
router.get("/exams/:examId/blocks/:blockId/reference",
  requireExamAccess, requirePermission(PERMISSIONS.GRADE_READ), requireGradingScope,
  async (req, res, next) => {
    try {
      const examId = Number(req.params.examId), blockId = String(req.params.blockId);
      const db = getMysqlDb();
      const rows = await db.all<{ question_numbers: string }>(
        "SELECT DISTINCT question_numbers FROM answer_block_crops WHERE exam_id=? AND block_id=?",
        examId, blockId);
      const numbers = new Set<number>();
      for (const row of rows) {
        try { for (const q of JSON.parse(row.question_numbers)) {
          const n = Number(q); if (Number.isInteger(n) && n > 0) numbers.add(n);
        } } catch { /* malformed historical metadata */ }
      }
      const questions = [...numbers].sort((a, b) => a - b);
      const keys = questions.length ? await db.all<{question_number:number;answer_text:string}>(
        `SELECT question_number,answer_text FROM exam_answer_keys WHERE exam_id=? AND question_number IN (${questions.map(() => "?").join(",")})`,
        examId, ...questions) : [];
      const { listAnswerKeyPages } = await import("../services/ExamPaperViewService");
      res.json({ok:true,data:{
        questions: questions.map(questionNumber => ({questionNumber,
          answerText: keys.find(k => Number(k.question_number) === questionNumber)?.answer_text ?? null})),
        answerPages: await listAnswerKeyPages(examId)
      }});
    } catch (error) { next(error); }
  });


// AI proposals are separate from formal grades. Missing/stale proposals return null.
router.get("/exams/:examId/block-crops/:cropId/ai-suggestion",
  requireExamAccess, requirePermission(PERMISSIONS.GRADE_READ), requireGradingScope,
  async(req,res,next)=>{
    try {
      const {authorizedAiCrop,readAiSuggestion}=await import("../services/AiScoreSuggestionService");
      const {crop}=await authorizedAiCrop(req);
      res.json({ok:true,data:await readAiSuggestion(crop)});
    } catch(error){next(error);}
  });
router.post("/exams/:examId/block-crops/:cropId/ai-suggestion/adopt",
  requireExamAccess, requirePermission(PERMISSIONS.GRADE_WRITE), requireGradingScope,
  async(req,res,next)=>{
    try {
      const {adoptAiDraft}=await import("../services/AiScoreSuggestionService");
      res.json({ok:true,data:await adoptAiDraft(req)});
    } catch(error){next(error);}
  });

// GET /api/review/my-exams — 教师有哪些考试有待阅任务
router.get("/my-exams", async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "未登录" });

    // 修复：原先 LEFT JOIN 后对 ra.student_count 做 SUM 会按切块行数重复放大。
    // 改为按分配行聚合，已阅数用每块的子查询精确统计。
    const rows = await getMysqlDb().all(
      `SELECT examId, totalCount,
              CASE WHEN rawPending < 0 THEN 0 ELSE rawPending END AS pendingCount
       FROM (
         SELECT ra.exam_id AS examId,
                SUM(ra.student_count) AS totalCount,
                SUM(ra.student_count) - SUM(COALESCE((
                  SELECT COUNT(*)
                  FROM answer_block_crops abc2
                  WHERE abc2.exam_id = ra.exam_id
                    AND abc2.block_id = ra.block_id
                    AND abc2.status = 'reviewed'
                    AND abc2.reviewer_id = ?
                ), 0)) AS rawPending
         FROM review_assignments ra
         WHERE ra.teacher_id = ?
         GROUP BY ra.exam_id
       ) t`,
      userId, userId
    );

    res.json({ ok: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/exams/:examId/blocks", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    // 安全 R03：`requireExamAccess` 只判定「能否看到这场考试」，题块级阅卷人因此能
    // 列出全卷题块与每题统计。读取侧按 `getPermittedBlocks` 收敛（null = 不受限）。
    const blocks = await listReviewBlocks(examId, getMysqlDb(), await getPermittedBlocks(req.user, examId));
    res.json({ ok: true, data: blocks, examId, blocks });
  } catch (error) {
    next(error);
  }
});

router.get("/exams/:examId/block-crops", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    const blockId = typeof req.query.blockId === "string" ? req.query.blockId.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const classId = optionalPositiveNumber(req.query.classId);
    // 安全 R03：切块清单含学生姓名/学号与答案图，题块级阅卷人只能读本人题块；
    // 显式请求了越权题块时直接 403（而非静默返回空列表，避免前端误判「无待阅」）。
    const permitted = await getPermittedBlocks(req.user, examId);
    if (permitted && blockId && !permitted.includes(blockId)) {
      res.status(403).json({ message: `权限不足：未获分配题块 ${blockId}` });
      return;
    }
    // 安全 B1：题块内按逐生分配再切一刀，清单口径与领取/原图三处对齐
    const slice = await assignedSliceFor(req.user, examId, blockId && permitted ? [blockId] : permitted);
    const rows = await listReviewBlockCropItems({
      examId,
      blockId: blockId || undefined,
      blockIds: permitted ?? undefined,
      classId: classId ?? undefined,
      status: status || undefined,
      assignedSlice: slice
    });
    res.json({ examId, rows });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/exams/:examId/block-crops/:cropId/submit",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradingScope,
  async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const cropId = String(req.params.cropId ?? "").trim();
      if (!Number.isFinite(examId) || !cropId) {
        res.status(400).json({ message: "参数无效" });
        return;
      }

      const scores = req.body?.scores as ReviewSubmitScoreInput[] | undefined;
      if (!Array.isArray(scores) || scores.length === 0) {
        res.status(400).json({ message: "请提供分数数据" });
        return;
      }

      const rawStatus = typeof req.body?.status === "string" ? req.body.status.trim() : "";
      let status: string | undefined;
      if (rawStatus === "") {
        status = undefined; // 未提供 → 服务层回退 "reviewed"（保持向后兼容）
      } else if (rawStatus === "draft" || rawStatus === "submitted" || rawStatus === "reviewed" || rawStatus === "disputed") {
        status = rawStatus;
      } else {
        throw new ReviewValidationError(`非法的 status 值: ${rawStatus}`);
      }
      const blockTotalScore =
        typeof req.body?.blockTotalScore === "number" ? req.body.blockTotalScore : undefined;
      const user = (req as any).user as { role_id?: number; role_name?: string; teacher_role?: string | null };
      const isAdmin = user?.role_id === 1;
      const isGradeLeader = user?.role_name === "teacher" && user?.teacher_role === "grade_leader";
      const result = await submitReviewCropScores({
        examId,
        cropId,
        scores,
        status,
        blockTotalScore,
        expectedVersion: Number.isSafeInteger(req.body?.version) && req.body.version >= 0
          ? req.body.version : undefined,
        userId: req.user!.id,
        // 管理员与学年主任均可代交/强制处理他人已领取的试卷
        isAdmin: isAdmin || isGradeLeader
      });
      res.json(result);
    } catch (error) {
      if (error instanceof ReviewValidationError) {
        res.status(422).json({ message: error.message });
        return;
      }
      if (error instanceof Error && /不存在|未关联/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      next(error);
    }
  }
);

// GET /api/review/exams/:examId/trace — 阅卷溯源
router.get("/exams/:examId/trace", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    const blockId = typeof req.query.blockId === "string" ? req.query.blockId : undefined;
    // 安全 R03：溯源表暴露全卷每题得分与评审人，同样按题块范围收敛。
    const permitted = await getPermittedBlocks(req.user, examId);
    if (permitted && blockId && !permitted.includes(blockId)) {
      res.status(403).json({ message: `权限不足：未获分配题块 ${blockId}` });
      return;
    }
    const trace = await getReviewTrace(
      examId,
      blockId,
      getMysqlDb(),
      permitted,
      // 安全 B1：溯源比清单更敏感（每题得分 + 评审人 + 学号），同样要收到逐生切片
      await assignedSliceFor(req.user, examId, blockId && permitted ? [blockId] : permitted)
    );
    res.json({ ok: true, data: trace });
  } catch (error) {
    next(error);
  }
});

export default router;
