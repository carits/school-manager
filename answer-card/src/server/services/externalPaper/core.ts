import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import sharp from "sharp";
import { getMysqlDb, buildUpsertSQL, type DbAdapter } from "../../db";
import { CardRepository } from "../../repositories/CardRepository";
import { ExamRepository } from "../../repositories/ExamRepository";
import { createDefaultCard, generateCardId } from "../../../shared/defaultCard";
import { externalBlockId, scoreExternalObjective, validateExternalKey, validateExternalTemplate, type ExternalAnswerKey, type ExternalObservation, type ExternalPageResult, type ExternalTemplate } from "../../../shared/externalPaper";
import { ensureExamParticipants, isExamParticipant } from "../examParticipants";
import { captureExamClasses, captureExistingExamClasses } from "../examClassMemberships";
import { upsertBlockConfig } from "../BlockGradingConfigService";
import { markScoreMutated } from "../examPublishEvents";
import { hashFile, hashText, pdfPages, renderPage, templateDirectory, batchDirectory, childPath } from "./files";
import type { ExternalPageRow } from "./worker";

export interface ExternalConfigRow { exam_id: number; card_id: string; template_hash: string; template_json: string; answer_key_json: string; assignments_json: string }
export interface ExternalSheetRow { id: string; exam_id: number; batch_id: string; student_id: number; student_number: string; page_ids_json: string; observations_json: string; scan_record_id: number; version: number }
export type ExternalAssignments = Record<string, { teacherIds: number[]; classIds: number[] }>;
export function paperError(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
export async function getExternalConfig(examId: number, db = getMysqlDb()): Promise<ExternalConfigRow> {
  return (await db.get<ExternalConfigRow>("SELECT * FROM external_paper_exams WHERE exam_id=?", examId)) ?? paperError("尚未设置现成答题卡模板", 404);
}
export async function configureExternalExam(examId: number, value: unknown, source: string, actorId: number, db = getMysqlDb()): Promise<void> {
  const template = validateExternalTemplate(value);
  if (await pdfPages(source) !== template.pages.length) paperError("空白 PDF 页数与模板不一致", 422);
  const hash = hashText(JSON.stringify(template) + await hashFile(source)), dir = templateDirectory(examId, hash);
  await mkdir(dir, { recursive: true });
  await copyFile(source, childPath(dir, "template.pdf"));
  for (const page of template.pages) await renderPage(source, page.number, childPath(dir, `page-${page.number}`));
  await db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const old = await tx.get<ExternalConfigRow>("SELECT * FROM external_paper_exams WHERE exam_id=?", examId);
    if (await tx.get("SELECT 1 FROM external_paper_batches WHERE exam_id=? LIMIT 1", examId)) paperError("已经上传扫描件，不能修改本场模板；请复制为新考试后校准");
    if (await tx.get("SELECT 1 FROM student_scores WHERE exam_id=? LIMIT 1", examId)) paperError("已有成绩的考试不能更换答题卡");
    const exam = await tx.get<{ subject: string | null }>("SELECT subject FROM exams WHERE id=?", examId);
    if (!exam) paperError("考试不存在", 404);
    const card = createDefaultCard(old?.card_id ?? generateCardId(`external-${examId}-${randomUUID()}`), exam.subject ?? "yuwen", "A3");
    card.title = `${template.title}（现成答题卡·${examId}）`;
    card.sided = template.pages.length > 1 ? "double" : "single";
    card.studentInfo.studentNumberDigits = template.identity.digits;
    // Each scoring block is globally unique and maps to exactly one logical question.
    card.bodyBlocks = template.questions.map(q => q.type === "objective" ? {
      id: externalBlockId(examId, q.number), type: "objective", title: `第 ${q.number} 题`, titleLocked: true,
      questionStart: q.number, questionCount: 1, optionCount: q.options!.length,
      mode: q.requiredSelections === 1 ? "single" : "multiple", scorePerQuestion: q.maxScore, density: "normal",
      questions: [{ questionNumber: q.number, score: q.maxScore, optionCount: q.options!.length, mode: q.requiredSelections === 1 ? "single" : "multiple" }]
    } : {
      id: externalBlockId(examId, q.number), type: "subjective", title: `第 ${q.number} 题`, titleLocked: true,
      blockKind: q.maxScore >= 30 ? "essay" : "answer",
      questions: [{ id: externalBlockId(examId, q.number), number: q.number, score: q.maxScore, style: "plain_subjective", kind: "plain_box", minHeightMm: 25 }]
    });
    const repo = new CardRepository(tx);
    if (!old) await repo.createCard(card, actorId);
    await repo.updateCardInTx(card, tx);
    const upsert = buildUpsertSQL(tx.dialect, "external_paper_exams", ["exam_id","card_id","template_hash","template_json","answer_key_json","assignments_json","created_by"], ["exam_id"], ["template_hash","template_json"]);
    await tx.run(upsert, examId, card.id, hash, JSON.stringify(template), "{}", "{}", actorId);
    for (const q of template.questions.filter(q => q.type === "subjective")) await upsertBlockConfig(examId, externalBlockId(examId, q.number), { reviewMode: 1, scoringMode: "block_total", hasHalfPoint: q.step === .5 ? 1 : 0, autoReassignNoArb: 0 }, tx);
    await tx.run("UPDATE exams SET card_id=?,review_mode=1,review_enabled=1,status='grading',score_published=0 WHERE id=?", card.id, examId);
    await ensureExamParticipants(tx, examId);
    await captureExistingExamClasses(tx, examId);
  });
}

/** A question has a null score until recognized/confirmed or graded. No missing page is scored as zero. */
export async function recomputeExternalStudent(tx: DbAdapter, examId: number, studentId: number, template?: ExternalTemplate): Promise<number | null> {
  const t = template ?? JSON.parse((await getExternalConfig(examId, tx)).template_json) as ExternalTemplate;
  const rows = await tx.all<{ question_number: number; score_type: string; score: number | null }>("SELECT question_number,score_type,score FROM question_scores WHERE exam_id=? AND student_id=?", examId, studentId);
  const crops = await tx.all<{ block_id: string; status: string }>("SELECT block_id,status FROM answer_block_crops WHERE exam_id=? AND student_id=?", examId, studentId);
  let objective = 0, subjective = 0, complete = true;
  for (const q of t.questions) {
    const row = rows.find(r => Number(r.question_number) === q.number && r.score_type === q.type);
    if (row?.score == null) complete = false;
    if (q.type === "subjective" && !crops.some(c => c.block_id === externalBlockId(examId, q.number) && c.status === "reviewed")) complete = false;
    if (q.type === "objective") objective += Number(row?.score ?? 0); else subjective += Number(row?.score ?? 0);
  }
  const total = complete ? objective + subjective : null;
  await tx.run("UPDATE student_scores SET objective_score=?,subjective_score=?,total_score=?,`rank`=NULL,percentile=NULL,assigned_score=NULL WHERE exam_id=? AND student_id=?", objective, subjective, total, examId, studentId);
  return total;
}
export async function assertExternalScoresComplete(db: DbAdapter, examId: number): Promise<void> {
  const config = await db.get<ExternalConfigRow>("SELECT * FROM external_paper_exams WHERE exam_id=?", examId);
  if (!config) return;
  const template = JSON.parse(config.template_json) as ExternalTemplate;
  const participants = await db.all<{ student_id: number }>("SELECT student_id FROM exam_participants WHERE exam_id=?", examId);
  for (const { student_id: sid } of participants) {
    const rows = await db.all<{ question_number: number; score_type: string; score: number | null }>("SELECT question_number,score_type,score FROM question_scores WHERE exam_id=? AND student_id=?", examId, sid);
    const done = await db.all<{ block_id: string }>("SELECT block_id FROM answer_block_crops WHERE exam_id=? AND student_id=? AND status='reviewed'", examId, sid);
    if (template.questions.some(q => !rows.some(r => Number(r.question_number) === q.number && r.score_type === q.type && r.score !== null && Number.isFinite(Number(r.score))) || (q.type === "subjective" && !done.some(c => c.block_id === externalBlockId(examId, q.number))))) {
      paperError("仍有缺页、客观题待确认或主观题未批完，不能公布正式成绩");
    }
  }
}
async function persistObjectiveScores(tx: DbAdapter, config: ExternalConfigRow, sheet: ExternalSheetRow, observations: ExternalObservation[], actorId: number): Promise<void> {
  const template = JSON.parse(config.template_json) as ExternalTemplate, key = JSON.parse(config.answer_key_json) as ExternalAnswerKey;
  for (const q of template.questions.filter(q => q.type === "objective")) {
    const observation = observations.find(o => o.questionNumber === q.number);
    const score = scoreExternalObjective(q, observation, key[String(q.number)]);
    await tx.run("UPDATE question_scores SET score=?,selected_options=?,modified_by=?,modified_at=CURRENT_TIMESTAMP WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'", score, observation ? JSON.stringify(observation.selectedOptions) : null, actorId, sheet.exam_id, sheet.student_id, q.number);
  }
  await recomputeExternalStudent(tx, sheet.exam_id, sheet.student_id, template);
}

/** Explicitly confirmed sheet ownership, including supplementing missing pages without deleting any previous grades. */
export async function confirmExternalSheet(examId: number, pageIds: string[], studentNumber: string, actorId: number, existingSheetId?: string, db = getMysqlDb()): Promise<string> {
  if (!Array.isArray(pageIds) || !pageIds.length || pageIds.length > 8 || new Set(pageIds).size !== pageIds.length || pageIds.some(p => typeof p !== "string" || p.length > 64)) paperError("配页信息无效", 422);
  const config = await getExternalConfig(examId, db), template = JSON.parse(config.template_json) as ExternalTemplate;
  if (!new RegExp(`^[0-9]{${template.identity.digits}}$`).test(studentNumber)) paperError(`考号必须为 ${template.identity.digits} 位数字，请保留前导零`, 422);
  return db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    await ensureExamParticipants(tx, examId);
    const matches = await tx.all<{ id: number }>("SELECT u.id FROM users u JOIN exam_participants ep ON ep.student_id=u.id AND ep.exam_id=? WHERE u.student_number=? AND u.role_id=3", examId, studentNumber);
    if (matches.length !== 1) paperError("考号未在本次应考名单中唯一对应学生，请先核对名单", 422);
    const studentId = matches[0].id;
    const existing = await tx.get<ExternalSheetRow>("SELECT * FROM external_paper_sheets WHERE exam_id=? AND student_id=?", examId, studentId);
    if (existing && existing.id !== existingSheetId) {
      if (JSON.stringify([...JSON.parse(existing.page_ids_json)].sort()) === JSON.stringify([...pageIds].sort())) return existing.id;
      paperError("该考号已有答卷；补页请明确选择已有答卷，不能覆盖原卷");
    }
    if (existingSheetId && (!existing || existing.id !== existingSheetId)) paperError("补页目标不匹配");
    const oldIds: string[] = existing ? JSON.parse(existing.page_ids_json) : [];
    if (pageIds.some(id => oldIds.includes(id))) paperError("本页已经配入该答卷，请只选择新补页");
    const allIds = [...oldIds, ...pageIds];
    const pageRows = await tx.all<ExternalPageRow & { exam_id: number }>(`SELECT p.*,b.exam_id FROM external_paper_pages p JOIN external_paper_batches b ON b.id=p.batch_id WHERE p.id IN (${allIds.map(() => "?").join(",")})`, ...allIds);
    if (pageRows.length !== allIds.length || pageRows.some(p => p.exam_id !== examId || (p.paper_id && p.paper_id !== existing?.id))) paperError("存在无权使用或已配给其他学生的页面");
    const results = pageRows.map(p => ({ page: p, result: JSON.parse(p.result_json) as ExternalPageResult }));
    if (results.some(p => p.result.status !== "ok")) paperError("包含定位失败页面，请重扫后再配页");
    const roles = results.map(p => p.result.pageNumber);
    if (new Set(roles).size !== roles.length || roles.some(n => !template.pages.some(p => p.number === n))) paperError("同一份答卷出现重复页型，请检查正反面");
    if (!roles.includes(template.identity.page)) paperError("需要先配入有考号栏的首页");
    // Human confirmation may correct an OMR identity error; both the observation and confirmed owner are retained.
    const id = existing?.id ?? randomUUID(), batchId = existing?.batch_id ?? pageRows[0].batch_id;
    const observations: ExternalObservation[] = existing ? JSON.parse(existing.observations_json) : [];
    for (const p of results.filter(p => pageIds.includes(p.page.id))) for (const o of p.result.questions) {
      if (!observations.some(v => v.questionNumber === o.questionNumber)) observations.push(o);
    }
    let recordId = existing?.scan_record_id;
    if (!existing) {
      if (await tx.get("SELECT 1 FROM student_scores WHERE exam_id=? AND student_id=?", examId, studentId)) paperError("该学生已有其他来源成绩，不能自动覆盖");
      const repo = new ExamRepository(tx), legacyBatch = await repo.createScanBatch(examId, `PDF ${batchId}`, actorId);
      const first = results.find(p => p.result.pageNumber === template.identity.page)!;
      const image = childPath(batchDirectory(examId, first.page.batch_id), `page-${first.page.page_index}`, "source.png");
      recordId = await repo.addScanRecord({ batch_id: legacyBatch, file_path: image, file_name: `答卷-${id}`, student_id: studentId, student_number: studentNumber });
      await tx.run("INSERT INTO student_scores (exam_id,student_id,total_score) VALUES (?,?,NULL)", examId, studentId);
      for (const q of template.questions) await tx.run("INSERT INTO question_scores (exam_id,student_id,question_number,question_id,block_id,score,max_score,score_type) VALUES (?,?,?,?,?,NULL,?,?)", examId, studentId, q.number, externalBlockId(examId, q.number), externalBlockId(examId, q.number), q.maxScore, q.type);
      await tx.run("INSERT INTO external_paper_sheets (id,exam_id,batch_id,student_id,student_number,page_ids_json,observations_json,scan_record_id,confirmed_by) VALUES (?,?,?,?,?,?,?,?,?)", id, examId, batchId, studentId, studentNumber, JSON.stringify(allIds), JSON.stringify(observations), recordId, actorId);
    } else {
      await tx.run("UPDATE external_paper_sheets SET page_ids_json=?,observations_json=?,version=version+1 WHERE id=?", JSON.stringify(allIds), JSON.stringify(observations), id);
    }
    await captureExamClasses(tx, examId, studentId);
    for (const pageId of pageIds) {
      const changed = await tx.run("UPDATE external_paper_pages SET paper_id=? WHERE id=? AND paper_id IS NULL", id, pageId);
      if (!changed.changes) paperError("页面刚被配入其他答卷，请刷新");
    }
    for (const q of template.questions.filter(q => q.type === "subjective")) {
      const blockId = externalBlockId(examId, q.number);
      if (await tx.get("SELECT 1 FROM answer_block_crops WHERE exam_id=? AND student_id=? AND block_id=?", examId, studentId, blockId)) continue;
      const requiredPages = [...new Set(q.regions!.map(r => r.page))];
      if (requiredPages.some(n => !roles.includes(n))) continue;
      const pieces = requiredPages.map(n => results.find(p => p.result.pageNumber === n)?.result.crops.find(c => c.questionNumber === q.number));
      if (pieces.some(c => !c)) paperError(`第 ${q.number} 题切图不完整`);
      const width = Math.max(...pieces.map(c => c!.width)), height = pieces.reduce((sum, c) => sum + c!.height + 24, 0);
      if (width * height > 40000000) paperError("题目图片过大，请减少同题区域");
      const targetDir = childPath(batchDirectory(examId, batchId), "sheets", id);
      await mkdir(targetDir, { recursive: true });
      const target = childPath(targetDir, `q${q.number}.png`);
      let top = 0;
      const overlays = pieces.map(c => { const position = { input: c!.path, top, left: 0 }; top += c!.height + 24; return position; });
      await sharp({ create: { width, height, channels: 3, background: "white" } }).composite(overlays).png().toFile(target);
      await tx.run("INSERT INTO answer_block_crops (id,card_id,exam_id,student_id,student_number,source_type,source_record_id,block_id,block_title,block_type,page_number,segment_index,question_numbers,rect_json,image_path,width_px,height_px,dpi,status) VALUES (?,?,?,?,?,'scan_record',?,?,?,'subjective',?,0,?,?,?,?,?,?,'ready')",
        randomUUID(), config.card_id, examId, studentId, studentNumber, String(recordId), blockId, `第 ${q.number} 题`, requiredPages[0], JSON.stringify([q.number]), JSON.stringify(q.regions![0].rect), target, width, height, Math.round(5000 * 72 / Math.max(template.pages[requiredPages[0]-1].widthPt, template.pages[requiredPages[0]-1].heightPt)));
    }
    const sheet = (await tx.get<ExternalSheetRow>("SELECT * FROM external_paper_sheets WHERE id=?", id))!;
    await markScoreMutated(tx, examId, actorId, "scanner_save");
    await persistObjectiveScores(tx, config, sheet, observations, actorId);
    await tx.run("UPDATE exams SET status='grading' WHERE id=?", examId);
    return id;
  });
}
export async function saveExternalKey(examId: number, value: unknown, actorId: number, db = getMysqlDb()): Promise<void> {
  await db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const config = await getExternalConfig(examId, tx), template = JSON.parse(config.template_json) as ExternalTemplate;
    const key = validateExternalKey(template, value);
    config.answer_key_json = JSON.stringify(key);
    await markScoreMutated(tx, examId, actorId, "answer_edit");
    await tx.run("UPDATE external_paper_exams SET answer_key_json=? WHERE exam_id=?", config.answer_key_json, examId);
    // Keep existing card semantics/export tools in sync, without rebuilding any geometry or deleting task rows.
    for (const q of template.questions.filter(q => q.type === "objective")) {
      const block = externalBlockId(examId, q.number);
      await tx.run("DELETE FROM objective_answer_keys WHERE block_id=?", block);
      if (key[String(q.number)]) await tx.run("INSERT INTO objective_answer_keys (block_id,question_number,correct_options) VALUES (?,?,?)", block, q.number, JSON.stringify(key[String(q.number)].options));
      await tx.run("UPDATE objective_questions SET scoring_rule_json=? WHERE block_id=? AND question_number=?", q.requiredSelections! > 1 ? JSON.stringify({ type: "fixed_partial", partialScore: key[String(q.number)]?.partialScore ?? 0, wrongOrExtraScore: 0 }) : null, block, q.number);
    }
    const sheets = await tx.all<ExternalSheetRow>("SELECT * FROM external_paper_sheets WHERE exam_id=?", examId);
    for (const sheet of sheets) await persistObjectiveScores(tx, config, sheet, JSON.parse(sheet.observations_json), actorId);
  });
}
export async function confirmExternalAnswer(examId: number, sheetId: string, questionNumber: number, options: string[], version: number, actorId: number, db = getMysqlDb()): Promise<void> {
  await db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const config = await getExternalConfig(examId, tx), t = JSON.parse(config.template_json) as ExternalTemplate;
    const q = t.questions.find(q => q.number === questionNumber && q.type === "objective");
    if (!q || !Array.isArray(options) || new Set(options).size !== options.length || options.some(o => !q.options!.some(v => v.label === o))) paperError("题号或选项不正确", 422);
    const sheet = await tx.get<ExternalSheetRow>("SELECT * FROM external_paper_sheets WHERE id=? AND exam_id=?", sheetId, examId);
    if (!sheet || sheet.version !== version) paperError("答卷已更新，请刷新后重新确认");
    const observations: ExternalObservation[] = JSON.parse(sheet.observations_json);
    const index = observations.findIndex(o => o.questionNumber === q.number);
    if (index < 0) paperError("题目所在页面尚未配入，不能把缺页改成空白");
    observations[index] = { ...observations[index], selectedOptions: [...options].sort(), status: options.length ? "clear" : "blank", confirmedBy: actorId };
    await tx.run("UPDATE external_paper_sheets SET observations_json=?,version=version+1 WHERE id=?", JSON.stringify(observations), sheet.id);
    await markScoreMutated(tx, examId, actorId, "answer_edit");
    await persistObjectiveScores(tx, config, sheet, observations, actorId);
  });
}
export async function saveExternalAssignments(examId: number, input: ExternalAssignments, actorId: number, db = getMysqlDb()): Promise<void> {
  await db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
    const config = await getExternalConfig(examId, tx), t = JSON.parse(config.template_json) as ExternalTemplate;
    await ensureExamParticipants(tx, examId); await captureExistingExamClasses(tx, examId);
    if (!input || typeof input !== "object" || Array.isArray(input)) paperError("分工格式不正确", 422);
    const old = JSON.parse(config.assignments_json) as ExternalAssignments;
    const cleaned: ExternalAssignments = {};
    for (const [number, rule] of Object.entries(input)) {
      const q = t.questions.find(q => String(q.number) === number && q.type === "subjective");
      if (!q || !rule || !Array.isArray(rule.teacherIds) || !Array.isArray(rule.classIds) || rule.teacherIds.length > 100 || rule.classIds.length > 100) paperError("分工题号或教师范围不正确", 422);
      const teacherIds = [...new Set(rule.teacherIds)], classIds = [...new Set(rule.classIds)];
      if ([...teacherIds, ...classIds].some(id => !Number.isSafeInteger(id) || id <= 0)) paperError("教师或班级无效", 422);
      const studentRows = await tx.all<{ student_id: number }>(`SELECT ep.student_id FROM exam_participants ep WHERE ep.exam_id=? ${classIds.length ? `AND EXISTS (SELECT 1 FROM exam_class_memberships m WHERE m.exam_id=ep.exam_id AND m.student_id=ep.student_id AND m.class_id IN (${classIds.map(() => "?").join(",")}))` : ""}`, examId, ...classIds);
      const ids = studentRows.map(s => s.student_id), blockId = externalBlockId(examId, q.number);
      const locked = await tx.all<{ claimed_by: number; student_id: number }>("SELECT claimed_by,student_id FROM answer_block_crops WHERE exam_id=? AND block_id=? AND claimed_by IS NOT NULL", examId, blockId);
      if (locked.some(c => !teacherIds.includes(c.claimed_by) || !ids.includes(c.student_id))) paperError("该题仍有教师正在批改；请先保存或释放当前答卷，再调整分工");
      for (const teacherId of teacherIds) {
        if (!await tx.get("SELECT 1 FROM users WHERE id=? AND role_id=2", teacherId)) paperError("分工中包含不存在的教师", 422);
      }
      await tx.run("DELETE FROM review_assignments WHERE exam_id=? AND block_id=?", examId, blockId);
      for (const teacherId of teacherIds) await tx.run("INSERT INTO review_assignments (exam_id,block_id,teacher_id,student_count,assigned_student_ids) VALUES (?,?,?,?,?)", examId, blockId, teacherId, ids.length, JSON.stringify(ids));
      cleaned[number] = { teacherIds, classIds };
    }
    // Missing keys are deliberate removals, but never silently remove a currently held paper.
    for (const number of Object.keys(old).filter(n => !cleaned[n])) {
      const block = externalBlockId(examId, Number(number));
      if (await tx.get("SELECT 1 FROM answer_block_crops WHERE exam_id=? AND block_id=? AND claimed_by IS NOT NULL", examId, block)) paperError("被移除的题目还有正在批改的答卷");
      await tx.run("DELETE FROM review_assignments WHERE exam_id=? AND block_id=?", examId, block);
    }
    await tx.run("UPDATE external_paper_exams SET assignments_json=? WHERE exam_id=?", JSON.stringify(cleaned), examId);
  });
}
