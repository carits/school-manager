/**
 * Temporary exam-22 English groups. Mount the companion router at /api/review-groups.
 * Initialization is explicit: never run DDL/backfill from a read endpoint.
 */
import type { Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, stat, writeFile, rename, rm } from "node:fs/promises";
import sharp from "sharp";
import { getMysqlDb, type DbAdapter } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import { canGradeBlock } from "../../apps/answer-card/server/middleware";
import { normalizePdfTemplate, type PdfQuestion, type PdfTemplate } from "../../shared/legacyPdf";
import { CLAIM_LOCK_TIMEOUT_MS, MAX_HELD_PAPERS_PER_BLOCK, MAX_HELD_PAPERS_TOTAL } from "../../shared/reviewPoolLimits";
import { legacyBlockId, recomputeLegacyPaperTotals } from "./LegacyPdfService";
import { ensureReviewGroupSchema, readActiveReviewGroups } from "./LegacyReviewGroupScoreService";
import { readAiSuggestion } from "./AiScoreSuggestionService";
import { markScoreMutated } from "./examPublishEvents";

type Row = Record<string, any>;
export type GroupMode = "draft" | "transition" | "active" | "readonly";
export interface GroupConfig {
  examId: number; id: string; title: string; questionNumbers: number[]; maxScore: number; mode: GroupMode;
}
export interface GroupItem {
  serialNumber: number; paperId: string; score: number | null; version: number; inputSignature: string;
  status: "ready" | "reviewed"; claimedBy: number | null; imageUrl: string;
  oldScores: Array<{ questionNumber: number; score: number | null; maxScore: number; reviewerName: string | null; reviewedAt: string | null }>;
  maxScore: number; title: string;
}
export interface GroupStats { assignedCount: number; pendingCount: number; reviewedCount: number; heldCount: number }
export interface GroupAi {
  score: number; maxScore: number;
  reasons: Array<{ questionNumber: number; score: number; reason: string }>; suggestionIds: string[];
}
export class LegacyReviewGroupError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "LegacyReviewGroupError"; }
}
function fail(status: number, message: string): never { throw new LegacyReviewGroupError(status,message); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = (value: any): any => typeof value === "string" ? JSON.parse(value) : value;
const placeholders = (xs: unknown[]) => xs.map(() => "?").join(",");
const accepted: Record<string, number[]> = {
  "english-46-55": Array.from({length: 10}, (_, i) => 46 + i),
  "english-56-60": Array.from({length: 5}, (_, i) => 56 + i)
};
const CACHE_LIMIT = 32 * 1024 * 1024;
const cacheRoot = () => path.join(process.env.ANSWER_CARD_DATA_DIR || path.resolve("data/answer-card"), "legacy-pdf", "group-cache");

export const REVIEW_GROUP_REQUEST_SCHEMA = `CREATE TABLE IF NOT EXISTS legacy_review_group_requests(
 exam_id INT NOT NULL,serial_no INT NOT NULL,group_id VARCHAR(64) NOT NULL,request_id VARCHAR(128) NOT NULL,
 actor_id INT NOT NULL,payload_hash CHAR(64) NOT NULL,response_json LONGTEXT NOT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(exam_id,serial_no,group_id,request_id)
)`;
/** Parent calls once, after the score agent's schema initializer. Does not seed assignments. */
export async function ensureLegacyReviewGroupServiceSchema(db: DbAdapter = getMysqlDb()) {
  await ensureReviewGroupSchema(db);
  await db.exec(REVIEW_GROUP_REQUEST_SCHEMA);
}
export function validateGroupConfig(row: Row): GroupConfig {
  const id = String(row.group_id), numbers = parse(row.questions_json);
  if (Number(row.exam_id) !== 22 || !accepted[id] || !Array.isArray(numbers) ||
      JSON.stringify(numbers.map(Number)) !== JSON.stringify(accepted[id]) || Number(row.max_score) !== 10 ||
      !["draft", "transition", "active", "readonly"].includes(row.mode)) fail(409, "分组配置不是已批准的英语临时分组");
  return {examId: 22, id, title: String(row.title), questionNumbers: accepted[id], maxScore: 10, mode: row.mode};
}
export function validateGroupScore(score: unknown, maxScore = 10): number {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > maxScore ||
      !Number.isInteger(score * 2)) fail(422, "分数须为满分范围内的整数或半分");
  return score;
}
export function groupStats(items: GroupItem[]): GroupStats {
  return {assignedCount: items.length, pendingCount: items.filter(x => x.status === "ready").length,
    reviewedCount: items.filter(x => x.status === "reviewed").length, heldCount: items.filter(x => x.claimedBy !== null).length};
}
export function canonicalAssignment(raw: any): string {
  if (raw == null || raw === "") return "all";
  let values: unknown; try { values = parse(raw); } catch { return fail(409, "原题块分配数据无效"); }
  if (!Array.isArray(values) || values.some(x => !Number.isSafeInteger(Number(x)) || Number(x) <= 0))
    fail(409, "原题块分配数据无效");
  return values.length ? JSON.stringify([...new Set(values.map(Number))].sort((a,b) => a-b)) : "all";
}
/** Check every teacher, not only the caller. Rows/IDs are left untouched. */
export function identicalAssignments(blockIds: string[], assignments: Row[]): void {
  const snapshots = blockIds.map(block => JSON.stringify(assignments.filter(r => r.block_id === block)
    .map(r => [Number(r.teacher_id), canonicalAssignment(r.assigned_student_ids)])
    .sort((a,b) => Number(a[0])-Number(b[0]))));
  if (new Set(snapshots).size > 1) fail(409, "子题块教师或学生分配不一致，分组已停止，未重新分配");
}
/** No updated_at/version exists in the legacy schema: content hash plus row ID/created_at is its revision. */
export function canonicalAssignmentHash(blockIds: string[], assignments: Row[]): string {
  return hash({blocks:[...blockIds].sort(),rows:assignments.map(r => ({
    blockId:String(r.block_id),id:r.id == null ? null : Number(r.id),teacherId:Number(r.teacher_id),
    assigned:canonicalAssignment(r.assigned_student_ids),studentCount:Number(r.student_count || 0),
    autoAssigned:Number(r.auto_assigned || 0),createdAt:r.created_at ?? null,
    version:r.version ?? null,updatedAt:r.updated_at ?? null
  })).sort((a,b) => a.blockId.localeCompare(b.blockId) || a.teacherId-b.teacherId)});
}
function actor(req: Request) {
  if (!req.user || !Number.isSafeInteger(Number(req.user.id)) || Number(req.user.id) <= 0) fail(401, "未登录");
  return Number(req.user!.id);
}
function privileged(req: Request) {
  return Number(req.user?.role_id) === 1 || (req.user?.role_name === "teacher" && req.user.teacher_role === "grade_leader");
}
function gate(req: Request) {
  actor(req);
  if (process.env.PROJECTX_LEGACY_ONLY !== "1") fail(404, "入口不存在");
  const examId = Number(req.params.examId);
  if (!Number.isSafeInteger(examId) || examId !== 22) fail(404, "临时分组不存在");
  return examId;
}
interface Scope { config: GroupConfig; templates: Map<string, PdfTemplate>; definitionHashes: Map<string,string>; definitionJson: Map<string,string>; members: Map<string,{questions:PdfQuestion[];blocks:Map<string,string>}>; assignmentHash: string; blockIds: string[]; assigned: Set<number> | null }
interface Paper { row: Row; marks: Row[]; pages: Row[]; questions: PdfQuestion[]; item: GroupItem }
interface ScopeInputs { config: Row; templates: Row[]; assignments: Row[] }
async function scope(req: Request, groupId: string, db: DbAdapter, lock = false, shared?: ScopeInputs): Promise<Scope> {
  const examId = gate(req);
  const row = shared?.config ?? await db.get<Row>("SELECT * FROM legacy_review_groups WHERE exam_id=? AND group_id=?" + (lock ? " FOR UPDATE" : ""), examId, groupId);
  if (!row) fail(404, "分组不存在");
  const config = validateGroupConfig(row!);
  const rows = shared?.templates ?? await db.all<Row>("SELECT DISTINCT t.id,t.definition_json FROM legacy_pdf_templates t JOIN legacy_pdf_batches b ON b.template_id=t.id WHERE b.exam_id=?" + (lock ? " FOR UPDATE" : ""),examId);
  if (!rows.length) fail(409, "分组没有扫描模板");
  const templates = new Map<string, PdfTemplate>(), definitionHashes = new Map<string,string>(), definitionJson = new Map<string,string>(), members = new Map<string,{questions:PdfQuestion[];blocks:Map<string,string>}>(), blockIds: string[] = [];
  for (const t of rows) {
    const def = normalizePdfTemplate(parse(t.definition_json));
    const questions = config.questionNumbers.map(n => def.questions.find(q => Number(q.displayNumber) === n));
    if (questions.some(q => !q || q.gradingType !== "teacher_score")) fail(409, "分组子题目缺失或题型不符");
    templates.set(t.id,def); definitionHashes.set(t.id,hash(t.definition_json));
    definitionJson.set(t.id,typeof t.definition_json === "string" ? t.definition_json : JSON.stringify(t.definition_json));
    const blocks=new Map(questions.map(q => [q!.questionId,legacyBlockId(t.id,q!.questionId)]));
    members.set(t.id,{questions:questions as PdfQuestion[],blocks}); blockIds.push(...blocks.values());
  }
  const ids = [...new Set(blockIds)];
  const assignments = shared ? shared.assignments.filter(r => ids.includes(r.block_id)) : await db.all<Row>(`SELECT * FROM review_assignments WHERE exam_id=? AND block_id IN (${placeholders(ids)}) ORDER BY block_id,teacher_id${lock ? " FOR UPDATE" : ""}`, examId, ...ids);
  identicalAssignments(ids, assignments);
  const mine = assignments.find(a => Number(a.teacher_id) === actor(req));
  // Identical assignment snapshots already prove positive block authorization for this teacher.
  if (!mine && !privileged(req)) for (const blockId of ids)
    if (!await canGradeBlock(req.user,examId,blockId)) fail(403,"无子题块阅卷权限");
  const raw = mine ? canonicalAssignment(mine.assigned_student_ids) : "all";
  return {config, templates, definitionHashes, definitionJson, members, assignmentHash:canonicalAssignmentHash(ids,assignments), blockIds: ids, assigned: privileged(req) || raw === "all" ? null : new Set(JSON.parse(raw))};
}
/** File metadata is memoized within a response; signatures require no repeat file-content hashes. */
async function pageStamps(pages: Row[]): Promise<Map<string, unknown>> {
  const stamps = new Map<string, unknown>();
  await Promise.all(pages.map(async p => {
    if (stamps.has(p.aligned_path)) return;
    if (p.status !== "recognized" || !p.aligned_path) { stamps.set(p.aligned_path, null); return; }
    try { const s = await stat(p.aligned_path); stamps.set(p.aligned_path, [s.size, s.mtimeMs, s.ctimeMs]); }
    catch { stamps.set(p.aligned_path, null); }
  }));
  return stamps;
}
async function papers(s: Scope, db: DbAdapter, serial?: number | number[], lock = false): Promise<Paper[]> {
  const c = s.config, assigned = s.assigned ? [...s.assigned] : null;
  if (assigned && !assigned.length) return [];
  const rows = await db.all<Row>(`SELECT p.id paper_id,p.student_id,p.identity_status,p.ownership_confirmed,b.template_id,
    ps.serial_no,g.score,g.status,g.version,g.claimed_by,g.claimed_at,g.graded_by,g.input_signature,g.max_score saved_max_score,g.paper_id group_paper_id
    FROM legacy_paper_serials ps JOIN legacy_pdf_papers p ON p.id=ps.paper_id
    JOIN legacy_pdf_batches b ON b.id=p.batch_id AND b.exam_id=ps.exam_id
    LEFT JOIN legacy_review_group_scores g ON g.exam_id=ps.exam_id AND g.serial_no=ps.serial_no AND g.group_id=?
    WHERE ps.exam_id=? AND p.identity_status='confirmed' AND p.ownership_confirmed=1${Array.isArray(serial) ? ` AND ps.serial_no IN (${placeholders(serial)})` : serial ? " AND ps.serial_no=?" : ""}
    ${assigned ? `AND p.student_id IN (${placeholders(assigned)})` : ""}
    ORDER BY ps.serial_no${lock ? " FOR UPDATE" : ""}`, c.id, c.examId, ...(Array.isArray(serial) ? serial : serial ? [serial] : []),...(assigned || []));
  if (rows.some(r => r.group_paper_id && r.group_paper_id !== r.paper_id)) fail(409, "流水号关联已变化，需要管理人员核对");
  const visible = rows.filter(r => !s.assigned || s.assigned.has(Number(r.student_id)));
  if (!visible.length) return [];
  const ids = visible.map(r => r.paper_id);
  // Three bounded batches; no per-question/paper score queries.
  const marks = await db.all<Row>(`SELECT m.*,abc.block_id,abc.student_id,abc.claimed_by child_claimed_by,abc.status child_status,
    abc.review_round,abc.reviewer_id,u.name reviewer_name,abc.reviewed_at FROM legacy_pdf_marks m
    JOIN answer_block_crops abc ON abc.id=m.crop_id AND abc.exam_id=? AND abc.source_record_id=m.paper_id AND abc.source_type='legacy_pdf'
    LEFT JOIN users u ON u.id=abc.reviewer_id
    WHERE m.paper_id IN (${placeholders(ids)}) AND abc.block_id IN (${placeholders(s.blockIds)})
    ORDER BY m.paper_id,m.question_id${lock ? " FOR UPDATE" : ""}`, c.examId, ...ids, ...s.blockIds);
  const pages = await db.all<Row>(`SELECT id,paper_id,page_role,aligned_path,version,status FROM legacy_pdf_pages WHERE paper_id IN (${placeholders(ids)}) ORDER BY id${lock ? " FOR UPDATE" : ""}`, ...ids);
  const stamps = await pageStamps(pages);
  const marksByPaper = new Map<string, Map<string, Row>>(), pagesByPaper = new Map<string, Row[]>();
  for (const m of marks) { if (!marksByPaper.has(m.paper_id)) marksByPaper.set(m.paper_id,new Map());
    const byQuestion = marksByPaper.get(m.paper_id)!; if (byQuestion.has(m.question_id)) fail(409,"原子题任务重复"); byQuestion.set(m.question_id,m); }
  for (const p of pages) { if (!pagesByPaper.has(p.paper_id)) pagesByPaper.set(p.paper_id,[]); pagesByPaper.get(p.paper_id)!.push(p); }
  const result: Paper[] = [];
  for (const row of visible) {
    const membership=s.members.get(row.template_id)!;
    const questions=membership.questions;
    row.definition_json=s.definitionJson.get(row.template_id);
    const mm=questions.map(q => marksByPaper.get(row.paper_id)?.get(q.questionId));
    if (mm.some((m,i) => !m || m.block_id !== membership.blocks.get(questions[i].questionId)) ||
        new Set(mm.map(m => m!.crop_id)).size !== questions.length) continue;
    const pp = pagesByPaper.get(row.paper_id) || [];
    const requiredRoles = new Set(questions.flatMap(q => (q.regions || []).map(r => r.pageRole)));
    if (!requiredRoles.size || [...requiredRoles].some(role => pp.filter(p => p.page_role === role && p.status === "recognized" && stamps.get(p.aligned_path)).length !== 1)) continue;
    const signature = hash({examId:c.examId,serial:row.serial_no,paper:row.paper_id,config:c,
      definition:s.definitionHashes.get(row.template_id),assignmentHash:s.assignmentHash,members:mm.map(m => [m!.id,m!.crop_id,m!.question_id,Number(m!.version),m!.score,m!.status]),
      pages:pp.map(p => [p.id,p.page_role,p.version,p.status,p.aligned_path,stamps.get(p.aligned_path)])});
    const item: GroupItem = {serialNumber:Number(row.serial_no), paperId:row.paper_id,
      score:row.score == null ? null : Number(row.score), version:Number(row.version || 0), inputSignature:signature,
      status:row.status === "reviewed" ? "reviewed" : "ready", claimedBy:row.claimed_by == null ? null : Number(row.claimed_by),
      imageUrl:`/api/review-groups/exams/${c.examId}/groups/${c.id}/papers/${row.serial_no}/image?signature=${signature}`,
      oldScores:questions.map((q,i) => ({questionNumber:Number(q.displayNumber), score:mm[i]!.score == null ? null : Number(mm[i]!.score),
        maxScore:q.maxScore,reviewerName:mm[i]!.reviewer_name || null, reviewedAt:mm[i]!.reviewed_at == null ? null :
          mm[i]!.reviewed_at instanceof Date ? mm[i]!.reviewed_at.toISOString() : String(mm[i]!.reviewed_at)})),
      maxScore:c.maxScore,title:c.title};
    result.push({row,marks:mm as Row[],pages:pp,questions,item});
  }
  return result;
}
const serialParam = (req: Request) => {
  const n = Number(req.params.serial);
  if (!Number.isSafeInteger(n) || n <= 0) fail(400, "流水号无效");
  return n;
};
async function one(req: Request, s: Scope, db: DbAdapter, lock = false) {
  const found = (await papers(s, db, serialParam(req), lock))[0];
  if (!found) fail(404, "试卷不存在、未就绪或不在分配范围");
  return found!;
}
function writable(s: Scope) {
  if (s.config.mode !== "active") fail(409, "分组未处于active模式，阅卷写操作已冻结");
}
/** Block selector counts require no image I/O and no per-paper decoration. */
async function aggregateStats(s: Pick<Scope,"config"|"assigned"|"templates"|"members">, db: DbAdapter): Promise<GroupStats> {
  const c=s.config, assigned=s.assigned ? [...s.assigned] : null;
  if (assigned && !assigned.length) return {assignedCount:0,pendingCount:0,reviewedCount:0,heldCount:0};
  // Subjective marks for a paper are generated in one transaction. An anchor mark,
  // plus its corrected page, is enough to count a paper without regrouping 10k crops
  // on every teacher page load. papers() still validates every member before display.
  const rolePredicates=[...s.templates].map(([id,def]) => ({
    id,role:def.pages[c.id === "english-46-55" ? 0 : 1]?.pageRole,
    anchor:s.members.get(id)?.blocks.values().next().value as string | undefined
  }));
  if (rolePredicates.some(r=>!r.role||!r.anchor)) fail(409,"题组页面或任务配置不完整");
  const roleSql=rolePredicates.map(() => "(b.template_id=? AND EXISTS(SELECT 1 FROM legacy_pdf_marks m JOIN answer_block_crops abc ON abc.id=m.crop_id WHERE m.paper_id=p.id AND abc.exam_id=ps.exam_id AND abc.source_type='legacy_pdf' AND abc.block_id=?) AND EXISTS(SELECT 1 FROM legacy_pdf_pages pg WHERE pg.paper_id=p.id AND pg.page_role=? AND pg.status='recognized' AND pg.aligned_path IS NOT NULL))").join(" OR ");
  const assignedSql=assigned ? "AND p.student_id IN ("+placeholders(assigned)+")" : "";
  const row=await db.get<Row>(`SELECT COUNT(*) assignedCount,
    COALESCE(SUM(COALESCE(g.status,'ready')='ready'),0) pendingCount,
    COALESCE(SUM(g.status='reviewed'),0) reviewedCount,
    COALESCE(SUM(g.claimed_by IS NOT NULL),0) heldCount,
    COALESCE(SUM(g.paper_id IS NOT NULL AND g.paper_id<>p.id),0) staleCount
    FROM legacy_paper_serials ps JOIN legacy_pdf_papers p ON p.id=ps.paper_id
    JOIN legacy_pdf_batches b ON b.id=p.batch_id AND b.exam_id=ps.exam_id
    LEFT JOIN legacy_review_group_scores g ON g.exam_id=ps.exam_id AND g.serial_no=ps.serial_no AND g.group_id=?
    WHERE ps.exam_id=? AND p.identity_status='confirmed' AND p.ownership_confirmed=1
    ${assignedSql} AND (${roleSql})`,
    c.id,c.examId,...(assigned || []),...rolePredicates.flatMap(r => [r.id,r.anchor,r.role]));
  if (Number(row?.staleCount)) fail(409,"流水号关联已变化，需要管理人员核对");
  return {assignedCount:Number(row?.assignedCount || 0),pendingCount:Number(row?.pendingCount || 0),
    reviewedCount:Number(row?.reviewedCount || 0),heldCount:Number(row?.heldCount || 0)};
}
/** Admin progress uses the same assignment scope and count query as the teacher selector.
 * Active group totals replace their historical child tasks exactly once; no scores are written.
 */
export async function readLegacyReviewGroupTeacherProgress(examId: number, db: DbAdapter = getMysqlDb()) {
  const rows: Array<{teacherId:number;teacherName:string;blockId:string;blockTitle:string;
    allocatedCount:number;assignedCount:number;scoredCount:number;claimedCount:number}> = [];
  const replacedBlockIds = new Set<string>();
  const groups = await readActiveReviewGroups(db,examId);
  if (!groups.length) return {rows,replacedBlockIds};
  const templateRows = await db.all<Row>("SELECT DISTINCT t.id,t.definition_json FROM legacy_pdf_templates t JOIN legacy_pdf_batches b ON b.template_id=t.id WHERE b.exam_id=?",examId);
  const templates = new Map<string,PdfTemplate>(templateRows.map(t=>[t.id,normalizePdfTemplate(parse(t.definition_json))]));
  const allAssignments = await db.all<Row>("SELECT ra.*,u.name teacher_name FROM review_assignments ra JOIN users u ON u.id=ra.teacher_id WHERE ra.exam_id=? ORDER BY ra.block_id,ra.teacher_id",examId);
  for (const row of groups) {
    const config = validateGroupConfig(row), members: Scope["members"] = new Map();
    const blockIds: string[] = [];
    for (const [id,def] of templates) {
      const questions = config.questionNumbers.map(n=>def.questions.find(q=>Number(q.displayNumber)===n));
      if (questions.some(q=>!q||q.gradingType!=="teacher_score")) fail(409,"分组子题目缺失或题型不符");
      const blocks = new Map(questions.map(q=>[q!.questionId,legacyBlockId(id,q!.questionId)]));
      members.set(id,{questions:questions as PdfQuestion[],blocks});blockIds.push(...blocks.values());
    }
    const ids = [...new Set(blockIds)], assignments = allAssignments.filter(a=>ids.includes(a.block_id));
    identicalAssignments(ids,assignments);
    ids.forEach(id=>replacedBlockIds.add(id));
    const teachers = new Map(assignments.map(a=>[Number(a.teacher_id),a]));
    for (const [teacherId,assignment] of teachers) {
      const raw=canonicalAssignment(assignment.assigned_student_ids);
      const assigned: Set<number>|null=raw==="all"?null:new Set<number>(JSON.parse(raw));
      const stats=await aggregateStats({config,templates,members,assigned},db);
      rows.push({teacherId,teacherName:String(assignment.teacher_name),blockId:config.id,
        blockTitle:config.title+"（合并阅卷）",allocatedCount:assigned?.size??stats.assignedCount,
        assignedCount:stats.assignedCount,scoredCount:stats.reviewedCount,claimedCount:stats.heldCount});
    }
  }
  return {rows,replacedBlockIds};
}
export async function listLegacyReviewGroups(req: Request, db = getMysqlDb()) {
  const examId = gate(req), configs = await db.all<Row>("SELECT * FROM legacy_review_groups WHERE exam_id=? ORDER BY group_id", examId);
  if (!configs.length) return [];
  const templates = await db.all<Row>("SELECT DISTINCT t.id,t.definition_json FROM legacy_pdf_templates t JOIN legacy_pdf_batches b ON b.template_id=t.id WHERE b.exam_id=?",examId);
  const assignments = await db.all<Row>("SELECT * FROM review_assignments WHERE exam_id=? ORDER BY block_id,teacher_id",examId);
  const groups = [];
  for (const row of configs) {
    try {
      const s = await scope(req,row.group_id,db,false,{config:row,templates,assignments});
      groups.push({...s.config,...await aggregateStats(s,db)});
    } catch (e) { if (e instanceof LegacyReviewGroupError && e.status === 403) continue; throw e; }
  }
  return groups.map(({examId:_examId,...g}) => g);
}
export async function getLegacyReviewGroupPool(req: Request, db = getMysqlDb()) {
  const s = await scope(req, String(req.params.groupId), db), items = (await papers(s, db)).map(p => p.item);
  return {items, stats:groupStats(items)};
}
export async function getLegacyReviewGroupPaper(req: Request, db = getMysqlDb()) {
  const s = await scope(req,String(req.params.groupId),db);
  return (await papers(s,db,serialParam(req)))[0]?.item || null;
}
export async function getLegacyReviewGroupReviewed(req: Request, db = getMysqlDb()) {
  const s = await scope(req, String(req.params.groupId), db);
  const rows = await db.all<Row>(`SELECT serial_no FROM legacy_review_group_scores WHERE exam_id=? AND group_id=? AND status='reviewed'
    ${privileged(req) ? "" : "AND graded_by=?"} ORDER BY serial_no`,s.config.examId,s.config.id,...(privileged(req) ? [] : [actor(req)]));
  if (!rows.length) return [];
  return (await papers(s,db,rows.map(r => Number(r.serial_no)))).map(p => p.item);
}
function next(candidates: Paper[], after?: number) {
  const eligible = candidates.filter(p => p.item.status === "ready" && p.item.claimedBy === null && p.marks.every(m => m.child_claimed_by == null));
  return eligible.find(p => p.item.serialNumber > (after || 0)) || eligible[0] || null;
}
function afterSerial(req: Request) {
  const value = req.method === "GET" ? req.query.afterSerial : req.body?.afterSerial;
  if (value == null || value === "") return undefined;
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) fail(400, "预取流水号无效");
  return n;
}
export async function previewLegacyReviewGroup(req: Request, db = getMysqlDb()) {
  const s = await scope(req, String(req.params.groupId), db);
  return next(await candidates(req,s,db,false), afterSerial(req))?.item || null;
}
export async function previewLegacyReviewGroups(req: Request, db = getMysqlDb()) {
  const s=await scope(req,String(req.params.groupId),db), after=afterSerial(req)||0;
  const items=(await candidates(req,s,db,false,3)).filter(p=>p.item.serialNumber!==after&&p.item.status==="ready"&&p.item.claimedBy===null&&p.marks.every(m=>m.child_claimed_by==null));
  return [...items.filter(p=>p.item.serialNumber>after),...items.filter(p=>p.item.serialNumber<after)].slice(0,3).map(p=>p.item);
}
/** Bounded lookahead shares the same decoration batch; never decorates the entire pool on a page switch. */
async function candidates(req: Request, s: Scope, db: DbAdapter, claim: boolean, limit = 2): Promise<Paper[]> {
  const after = afterSerial(req), c = s.config, assigned = s.assigned ? [...s.assigned] : null;
  if (assigned && !assigned.length) return [];
  for(let offset=0;;offset+=limit){
  const rows = await db.all<Row>(`SELECT ps.serial_no FROM legacy_paper_serials ps
    JOIN legacy_pdf_papers p ON p.id=ps.paper_id JOIN legacy_pdf_batches b ON b.id=p.batch_id AND b.exam_id=ps.exam_id
    LEFT JOIN legacy_review_group_scores g ON g.exam_id=ps.exam_id AND g.serial_no=ps.serial_no AND g.group_id=?
    WHERE ps.exam_id=? AND p.identity_status='confirmed' AND p.ownership_confirmed=1
    AND COALESCE(g.status,'ready')='ready' AND (g.claimed_by IS NULL${claim ? " OR g.claimed_by=?" : ""})
    ${assigned ? `AND p.student_id IN (${placeholders(assigned)})` : ""}
    AND NOT EXISTS(SELECT 1 FROM answer_block_crops abc WHERE abc.exam_id=ps.exam_id AND abc.source_record_id=p.id
      AND abc.source_type='legacy_pdf' AND abc.block_id IN (${placeholders(s.blockIds)}) AND abc.claimed_by IS NOT NULL)
    ORDER BY ${claim && after===undefined ? "(g.claimed_by=?) DESC," : ""} CASE WHEN ps.serial_no>? THEN 0 ELSE 1 END,ps.serial_no LIMIT ${limit} OFFSET ?`,
    c.id,c.examId,...(claim ? [actor(req)] : []),...(assigned || []),...s.blockIds,...(claim && after===undefined ? [actor(req)] : []),after || 0,offset);
  if (!rows.length) return [];
  const decorated=await papers(s,db,rows.map(r => Number(r.serial_no)),claim);
  if (decorated.length || rows.length<limit) return decorated;
  }
}
async function quota(req: Request, s: Scope, tx: DbAdapter) {
  if (privileged(req)) return;
  // Parent's old-pool counter uses this same teacher lock. Group leases count exactly one.
  const held = await tx.get<Row>(`SELECT
    (SELECT COUNT(*) FROM answer_block_crops WHERE claimed_by=?) +
    (SELECT COUNT(*) FROM legacy_review_group_scores WHERE claimed_by=?) total,
    (SELECT COUNT(*) FROM legacy_review_group_scores WHERE exam_id=? AND group_id=? AND claimed_by=?) in_group`,
    actor(req), actor(req), s.config.examId, s.config.id, actor(req));
  if (Number(held?.total) >= MAX_HELD_PAPERS_TOTAL || Number(held?.in_group) >= MAX_HELD_PAPERS_PER_BLOCK)
    fail(403, "当前打开的未提交试卷过多，请先完成或切换");
}
export async function claimLegacyReviewGroup(req: Request, specific = false, db = getMysqlDb()) {
  gate(req);
  return db.transactionWithNamedLock("px_review_claim_" + actor(req), CLAIM_LOCK_TIMEOUT_MS, async tx => {
    const s = await scope(req, String(req.params.groupId), tx, true); writable(s);
    const eligible = specific ? await papers(s,tx,serialParam(req),true) : await candidates(req,s,tx,true);
    const after=afterSerial(req);
    const p = specific ? eligible[0] : after===undefined
      ? eligible.find(p => p.item.claimedBy === actor(req)) || next(eligible)
      : eligible.find(p => p.item.claimedBy === actor(req) && p.item.serialNumber>after) || next(eligible,after);
    if (!p) { if (specific) fail(404, "试卷不存在或不在分配范围"); return null; }
    if ((p.item.claimedBy !== null && p.item.claimedBy !== actor(req)) || p.marks.some(m => m.child_claimed_by != null))
      fail(409,"这份试卷正在其他页面处理中，请刷新");
    // Moving to another pending paper discards the former unfinished page in this
    // workflow. Release only that page, in the same transaction as the new claim.
    if (!specific && after!==undefined && p.item.serialNumber!==after)
      await tx.run("UPDATE legacy_review_group_scores SET claimed_by=NULL,claimed_at=NULL WHERE exam_id=? AND group_id=? AND serial_no=? AND claimed_by=? AND status='ready'",
        s.config.examId,s.config.id,after,actor(req));
    if (p.item.claimedBy === actor(req)) {
      if (p.row.input_signature !== p.item.inputSignature)
        await tx.run("UPDATE legacy_review_group_scores SET input_signature=? WHERE exam_id=? AND serial_no=? AND group_id=? AND claimed_by=?",
          p.item.inputSignature,s.config.examId,p.item.serialNumber,s.config.id,actor(req));
      return p.item;
    }
    if (p.item.status === "reviewed" && !privileged(req) && Number(p.row.graded_by) !== actor(req)) fail(403, "只能修改本人批阅的分组");
    await quota(req, s, tx);
    await tx.run(`INSERT INTO legacy_review_group_scores(exam_id,serial_no,group_id,paper_id,score,max_score,status,version,source,claimed_by,claimed_at,input_signature)
      VALUES(?,?,?,?,NULL,?,'ready',0,'teacher',?,?,?)
      ON DUPLICATE KEY UPDATE claimed_by=VALUES(claimed_by),claimed_at=VALUES(claimed_at),input_signature=VALUES(input_signature)`,
      s.config.examId,p.item.serialNumber,s.config.id,p.item.paperId,s.config.maxScore,actor(req),databaseTimestamp(),p.item.inputSignature);
    return {...p.item,claimedBy:actor(req)};
  });
}
async function audit(tx: DbAdapter, s: Scope, serial: number, action: string, userId: number, before: any, after: any) {
  await tx.run("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json) VALUES(?,?,?,?,?,?)",
    "review_group", `${s.config.examId}:${serial}:${s.config.id}`,action,userId,before == null ? null : JSON.stringify(before),JSON.stringify(after));
}
export async function submitLegacyReviewGroup(req: Request, db = getMysqlDb()) {
  const examId = gate(req), serial = serialParam(req), userId = actor(req), groupId = String(req.params.groupId);
  const body = req.body || {}, score = validateGroupScore(body.score);
  if (!Number.isSafeInteger(body.version) || body.version < 0 || typeof body.inputSignature !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.inputSignature) || typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.requestId)) fail(400, "缺少有效的版本、输入签名或请求编号");
  const payloadHash = hash({userId,score,version:body.version,inputSignature:body.inputSignature});
  return db.transactionWithNamedLock("px_review_claim_" + userId, CLAIM_LOCK_TIMEOUT_MS, async tx => {
    const s = await scope(req,groupId,tx,true); writable(s);
    // Config-row lock serializes first insert and dedup, even when a score row doesn't yet exist.
    const replay = await tx.get<Row>("SELECT * FROM legacy_review_group_requests WHERE exam_id=? AND serial_no=? AND group_id=? AND request_id=? FOR UPDATE",
      examId, serial, groupId, body.requestId);
    if (replay) {
      if (Number(replay.actor_id) !== userId || replay.payload_hash !== payloadHash) fail(409, "请求编号已被用于其他提交");
      // Recheck paper assignment on replay too.
      await one(req, s, tx, true);
      return {...parse(replay.response_json), reused:true};
    }
    const p = await one(req, s, tx, true);
    if (p.item.claimedBy !== userId) fail(409, "请先打开这份试卷");
    if (p.marks.some(m => m.child_claimed_by != null)) fail(409, "原题块正在其他页面处理中，暂不能保存整组分数");
    if (p.item.version !== body.version || p.item.inputSignature !== body.inputSignature ||
        p.row.input_signature !== body.inputSignature) fail(409, "试卷输入或分数版本已变化，请刷新");
    // Score agent returns snake-case configs for modes transition/active/readonly.
    const authoritative = await readActiveReviewGroups(tx, examId);
    if (!authoritative.some(g => g.group_id === groupId)) fail(409, "分组尚未参与正式总分");
    const item: GroupItem = {...p.item,score,status:"reviewed",version:p.item.version+1,claimedBy:null};
    await audit(tx,s,serial,p.item.score == null ? "score" : "rescore",userId,
      {score:p.item.score,version:p.item.version}, {score,version:item.version,inputSignature:body.inputSignature,requestId:body.requestId});
    const update = await tx.run(`UPDATE legacy_review_group_scores SET score=?,max_score=?,status='reviewed',version=version+1,
      graded_by=?,graded_at=?,source='teacher',claimed_by=NULL,claimed_at=NULL,input_signature=?
      WHERE exam_id=? AND serial_no=? AND group_id=? AND version=? AND claimed_by=?`,
      score,s.config.maxScore,userId,databaseTimestamp(),body.inputSignature,examId,serial,groupId,body.version,userId);
    if (update.changes !== 1) fail(409, "试卷版本或处理状态已变化");
    const paperTotalScore = await recomputeLegacyPaperTotals(tx,p.item.paperId,userId);
    await markScoreMutated(tx,examId,userId,"review_submit");
    const response = {data:item,paperTotalScore,reused:false};
    await tx.run("INSERT INTO legacy_review_group_requests(exam_id,serial_no,group_id,request_id,actor_id,payload_hash,response_json) VALUES(?,?,?,?,?,?,?)",
      examId,serial,groupId,body.requestId,userId,payloadHash,JSON.stringify(response));
    return response;
  });
}
export async function getLegacyReviewGroupReference(req: Request, db = getMysqlDb()) {
  const s = await scope(req,String(req.params.groupId),db);
  const rows = await db.all<Row>(`SELECT question_number,answer_text FROM exam_answer_keys WHERE exam_id=? AND question_number IN (${placeholders(s.config.questionNumbers)})`,
    s.config.examId,...s.config.questionNumbers);
  return {questions:s.config.questionNumbers.map(n => ({questionNumber:n,answerText:String(rows.find(r => Number(r.question_number) === n)?.answer_text || "")}))};
}
export function aggregateGroupAi(config: GroupConfig, suggestions: Array<any | null>): GroupAi | null {
  if (suggestions.length !== config.questionNumbers.length || suggestions.some((s,i) => !s || s.questionNumber !== config.questionNumbers[i] ||
      typeof s.score !== "number" || !Number.isFinite(s.score) || s.score < 0 || s.score > s.maxScore)) return null;
  const score = suggestions.reduce((sum,s) => sum+s.score,0), maxScore = suggestions.reduce((sum,s) => sum+s.maxScore,0);
  if (maxScore !== config.maxScore || score > config.maxScore || !Number.isInteger(score*2) || new Set(suggestions.map(s => s.id)).size !== suggestions.length) return null;
  return {score,maxScore:config.maxScore,reasons:suggestions.map(s => ({questionNumber:s.questionNumber,score:s.score,reason:String(s.reason)})),
    suggestionIds:suggestions.map(s => String(s.id))};
}
async function ai(s: Scope, p: Paper): Promise<GroupAi | null> {
  // Existing validator checks definition, rubric, corrected page versions AND cached content hashes for every member.
  const suggestions = [];
  for (const m of p.marks) {
    let suggestion;
    try { suggestion = await readAiSuggestion({id:m.crop_id,exam_id:s.config.examId,paper_id:p.item.paperId,
      serial_no:p.item.serialNumber,template_id:p.row.template_id,definition_json:p.row.definition_json}); }
    catch (e) { if (e instanceof SyntaxError) return null; throw e; }
    if (!suggestion) return null;
    const question = p.questions.find(q => q.questionId === m.question_id);
    if (!question || suggestion.maxScore !== question.maxScore) return null;
    suggestions.push(suggestion);
  }
  return aggregateGroupAi(s.config,suggestions);
}
export async function getLegacyReviewGroupAi(req: Request, db = getMysqlDb()) {
  const s = await scope(req,String(req.params.groupId),db);
  return ai(s,await one(req,s,db));
}
export async function adoptLegacyReviewGroupAi(req: Request, db = getMysqlDb()) {
  gate(req);
  return db.transactionWithNamedLock("px_review_claim_" + actor(req), CLAIM_LOCK_TIMEOUT_MS, async tx => {
    const s = await scope(req,String(req.params.groupId),tx,true); writable(s);
    const p = await one(req,s,tx,true);
    if (p.item.claimedBy !== actor(req)) fail(409, "请先打开这份试卷");
    // Validator uses its established adapter; lock the compared DB inputs here until adoption commits.
    await tx.all(`SELECT * FROM legacy_ai_score_suggestions WHERE crop_id IN (${placeholders(p.marks)}) ORDER BY crop_id FOR UPDATE`,...p.marks.map(m => m.crop_id));
    await tx.all(`SELECT * FROM exam_answer_keys WHERE exam_id=? AND question_number IN (${placeholders(s.config.questionNumbers)}) ORDER BY question_number FOR UPDATE`,s.config.examId,...s.config.questionNumbers);
    const aggregate = await ai(s,p), ids = req.body?.suggestionIds;
    if (!aggregate || !Array.isArray(ids) || JSON.stringify(ids) !== JSON.stringify(aggregate.suggestionIds))
      fail(409, "AI建议已失效或未覆盖全部题目");
    if ((await one(req,s,tx,true)).item.inputSignature !== p.item.inputSignature) fail(409,"答卷输入已变化");
    for (let i=0;i<ids.length;i++) await tx.run("INSERT INTO legacy_ai_score_adoptions(suggestion_id,actor_id,crop_id) VALUES(?,?,?)",
      ids[i],actor(req),p.marks[i].crop_id);
    await audit(tx,s,p.item.serialNumber,"adopt_ai_draft",actor(req),null,{...aggregate,formalScoreWritten:false});
    return {data:aggregate!,formalScoreWritten:false as const};
  });
}
export function unionGroupRegions(config: GroupConfig, def: PdfTemplate, questions: PdfQuestion[]) {
  const regions = questions.flatMap(q => q.regions || []);
  const role = def.pages[config.id === "english-46-55" ? 0 : 1]?.pageRole;
  if (!regions.length || regions.some(r => r.pageRole !== role)) fail(409, "分组答题区域必须属于原正面或背面");
  const left = Math.min(...regions.map(r => r.rect.x)), top = Math.min(...regions.map(r => r.rect.y));
  const right = Math.max(...regions.map(r => r.rect.x+r.rect.width)), bottom = Math.max(...regions.map(r => r.rect.y+r.rect.height));
  if (![left,top,right,bottom].every(Number.isFinite) || left < 0 || top < 0 || right > 1.00001 || bottom > 1.00001 || right <= left || bottom <= top)
    fail(409, "原答题区域无效");
  // The union must never include a printed/scanned identity field.
  for (const identity of def.identities.filter(i => i.pageRole === role)) {
    const identityRects = [identity.rect,...(identity.cells || []).map(c => c.rect)].filter(Boolean);
    if (identityRects.some(r => r!.x < right && r!.x+r!.width > left && r!.y < bottom && r!.y+r!.height > top))
      fail(409, "分组图片区域与身份区域重叠");
  }
  return {role:role!,left,top,right:Math.min(1,right),bottom:Math.min(1,bottom)};
}
let cacheQueue: Promise<unknown> = Promise.resolve();
async function cachedImage(key: string, render: () => Promise<Buffer>): Promise<string> {
  const root = cacheRoot(), target = path.join(root,key+".webp");
  // Hits must not queue behind another teacher's cold image conversion.
  try { if ((await stat(target)).size <= CACHE_LIMIT) return target; } catch {}
  const job = cacheQueue.catch(() => {}).then(async () => {
    await mkdir(root,{recursive:true});
    try { if ((await stat(target)).size <= CACHE_LIMIT) return target; } catch {}
    const buffer = await render();
    if (buffer.length > CACHE_LIMIT) fail(413, "分组图片超过32MiB");
    const files = await Promise.all((await readdir(root)).filter(n => /^[a-f0-9]{64}\.(png|webp)$/.test(n))
      .map(async name => ({name,info:await stat(path.join(root,name))})));
    files.sort((a,b) => a.info.mtimeMs-b.info.mtimeMs);
    let size = files.reduce((n,f) => n+f.info.size,0);
    for (const f of files) { if (size+buffer.length <= CACHE_LIMIT) break; await rm(path.join(root,f.name),{force:true}); size-=f.info.size; }
    const temp = target+"."+randomUUID()+".tmp";
    try { await writeFile(temp,buffer,{flag:"wx",mode:0o600}); await rename(temp,target); }
    finally { await rm(temp,{force:true}); }
    return target;
  });
  cacheQueue = job; return job;
}
export async function getLegacyReviewGroupImage(req: Request, db = getMysqlDb()) {
  const s = await scope(req,String(req.params.groupId),db), p = await one(req,s,db);
  if (req.query.signature && req.query.signature !== p.item.inputSignature) fail(409, "图片版本已变化，请刷新");
  const region = unionGroupRegions(s.config,s.templates.get(p.row.template_id)!,p.questions);
  const page = p.pages.find(v => v.page_role === region.role)!;
  return cachedImage(hash([p.item.inputSignature,region,"webp92-v1"]),async () => {
    const meta = await sharp(page.aligned_path,{limitInputPixels:32*1024*1024}).metadata();
    if (!meta.width || !meta.height) fail(409, "校正页没有有效尺寸");
    const left=Math.floor(region.left*meta.width!),top=Math.floor(region.top*meta.height!);
    const width=Math.min(meta.width!-left,Math.ceil(region.right*meta.width!)-left);
    const height=Math.min(meta.height!-top,Math.ceil(region.bottom*meta.height!)-top);
    if (width*height*4 > CACHE_LIMIT) fail(413, "分组图片解码超过32MiB");
    // Preserve the original pixel dimensions and handwriting detail while
    // avoiding the much larger lossless PNG transfer for noisy scanned paper.
    const buffer = await sharp(page.aligned_path,{limitInputPixels:32*1024*1024}).extract({left,top,width,height}).webp({quality:92,effort:3}).toBuffer();
    // Prevent publishing a cache entry if corrected input changed while rendering.
    const current = await one(req,s,db);
    if (current.item.inputSignature !== p.item.inputSignature) fail(409, "校正页已变化，请刷新");
    return buffer;
  });
}
