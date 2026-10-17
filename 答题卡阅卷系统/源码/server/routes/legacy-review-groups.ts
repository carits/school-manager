import { Router, type Request, type Response } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import {
  LegacyReviewGroupError, listLegacyReviewGroups, getLegacyReviewGroupPool, getLegacyReviewGroupPaper,
  getLegacyReviewGroupReviewed, previewLegacyReviewGroup, previewLegacyReviewGroups, claimLegacyReviewGroup, submitLegacyReviewGroup,
  getLegacyReviewGroupReference, getLegacyReviewGroupAi, adoptLegacyReviewGroupAi, getLegacyReviewGroupImage
} from "../services/LegacyReviewGroupService";

/** Parent mounts at /api/review-groups and calls ensureLegacyReviewGroupServiceSchema explicitly. */
const router = Router();
const base = "/exams/:examId/groups/:groupId";
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => { void fn(req,res).catch(error => {
    const status = error instanceof LegacyReviewGroupError ? error.status :
      error?.name === "NamedLockTimeoutError" || error?.code === "ER_LOCK_DEADLOCK" || error?.code === "ER_LOCK_WAIT_TIMEOUT" ? 409 : 500;
    if (!res.headersSent) res.status(status).json({ok:false,error:status === 500 ? "服务器错误" : error.message});
    else res.destroy();
  }); };
}
// Existing exam/permission middleware plus service authorization of EVERY original child block.
// requireGradingScope reads a single blockId, so a synthetic groupId cannot be passed to that middleware.
const read = [requireExamAccess, requirePermission(PERMISSIONS.GRADE_READ)];
const write = [requireExamAccess, requirePermission(PERMISSIONS.GRADE_WRITE)];
router.get("/exams/:examId", ...read, wrap(async (req,res) => res.json({ok:true,groups:await listLegacyReviewGroups(req)})));
router.get(base, ...read, wrap(async (req,res) => res.json({ok:true,data:await getLegacyReviewGroupPool(req)})));
router.get(base+"/next-preview", ...read, wrap(async (req,res) => res.json({ok:true,data:await previewLegacyReviewGroup(req)})));
router.get(base+"/next-previews", ...read, wrap(async (req,res) => res.json({ok:true,data:await previewLegacyReviewGroups(req)})));
router.post(base+"/claim-next", ...write, wrap(async (req,res) => res.json({ok:true,data:await claimLegacyReviewGroup(req)})));
router.get(base+"/reviewed", ...read, wrap(async (req,res) => res.json({ok:true,data:await getLegacyReviewGroupReviewed(req)})));
router.get(base+"/reference", ...read, wrap(async (req,res) => res.json({ok:true,data:await getLegacyReviewGroupReference(req)})));
router.get(base+"/papers/:serial", ...read, wrap(async (req,res) => res.json({ok:true,data:await getLegacyReviewGroupPaper(req)})));
router.post(base+"/papers/:serial/claim", ...write, wrap(async (req,res) => res.json({ok:true,data:await claimLegacyReviewGroup(req,true)})));
router.post(base+"/papers/:serial/submit", ...write, wrap(async (req,res) => res.json({ok:true,...await submitLegacyReviewGroup(req)})));
router.get(base+"/papers/:serial/image", ...read, wrap(async (req,res) => {
  const file = await getLegacyReviewGroupImage(req);
  res.setHeader("Cache-Control","private, no-cache");
  res.type("webp");
  res.sendFile(file, (error: Error) => { if (error && !res.headersSent) res.status(409).json({ok:false,error:"图片缓存已变化，请重试"}); });
}));
router.get(base+"/papers/:serial/ai", ...read, wrap(async (req,res) => res.json({ok:true,data:await getLegacyReviewGroupAi(req)})));
router.post(base+"/papers/:serial/adopt-ai", ...write, wrap(async (req,res) => res.json({ok:true,...await adoptLegacyReviewGroupAi(req)})));
export default router;
