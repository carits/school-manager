import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { blockCropsDir, safeId } from "../../apps/answer-card/server/storage";
import type { AnswerBlockCrop, AnswerBlockCropSourceType, RecognitionBlockCrop, Rect } from "../../shared/types";
import { CardRepository } from "../repositories/CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type { AnswerCard } from "../../shared/types";
import { examClassPredicate } from "./examClassMemberships";

type CropRow = {
  id: string;
  card_id: string;
  exam_id: number | null;
  student_id: number | null;
  student_number: string | null;
  student_name?: string | null;
  source_type: AnswerBlockCropSourceType;
  source_record_id: string;
  block_id: string;
  block_title: string | null;
  block_type: string;
  page_number: number;
  segment_index: number;
  question_numbers: string;
  rect_json: string;
  image_path: string;
  width_px: number;
  height_px: number;
  dpi: number;
  status: string | null;
  score?: number | null;
  max_score?: number | null;
  claimed_by?: number | null;
  claimed_at?: string | null;
  claim_count?: number;
  review_round?: number | null;
};

export type PersistAnswerBlockCropsParams = {
  cardId: string;
  examId?: number | null;
  studentId?: number | null;
  studentNumber?: string | null;
  sourceType: AnswerBlockCropSourceType;
  sourceRecordId: string | number;
  crops?: RecognitionBlockCrop[] | null;
};

function cropImageUrl(id: string): string {
  return `/api/answer-block-crops/${encodeURIComponent(id)}/image`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toAnswerBlockCrop(row: CropRow): AnswerBlockCrop {
  return {
    id: row.id,
    cardId: row.card_id,
    examId: row.exam_id,
    studentId: row.student_id,
    studentNumber: row.student_number,
    sourceType: row.source_type,
    sourceRecordId: row.source_record_id,
    blockId: row.block_id,
    blockTitle: row.block_title ?? "",
    blockType: row.block_type,
    pageNumber: Number(row.page_number),
    segmentIndex: Number(row.segment_index),
    questionNumbers: parseJson<Array<number | string>>(row.question_numbers, []),
    rect: parseJson<Rect>(row.rect_json, { x: 0, y: 0, width: 0, height: 0 }),
    imageUrl: cropImageUrl(row.id),
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    dpi: Number(row.dpi),
    status: row.status ?? "ready",
    score: row.score ?? null,
    maxScore: row.max_score ?? null,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    claimCount: row.claim_count ?? 0,
    reviewRound: Number(row.review_round ?? 0)
  };
}

async function moveCropFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await rename(sourcePath, targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
    await unlink(sourcePath).catch(() => {});
  }
}

/**
 * 安全（R07）：切块文件名由清单字段拼出，页码/分段号必须先收敛为非负整数。
 * 未收敛时 `"pageNumber": "../../x"` 这类值会直接进入文件名，把切块搬到切块目录之外。
 */
function safePartIndex(value: unknown, max = 9999): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
}

function targetFileName(crop: RecognitionBlockCrop, index: number): string {
  const block = safeId(crop.blockId) || "block";
  const page = safePartIndex(crop.pageNumber, 9999);
  const segment = safePartIndex(crop.segmentIndex, 9999);
  return `p${page}_s${segment}_${String(index + 1).padStart(2, "0")}_${block}.png`;
}

/** 路径必须严格落在 base 目录内（R07：拒绝 `..`、绝对路径与同前缀目录名）。 */
export function isInsideDir(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(target);
  return resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep);
}

/** 切块持久化统计（五轮D1：空/无效切块不再静默，返回统计 + 日志定位） */
export interface CropPersistenceStats {
  /** 成功落库的切块数 */
  persisted: number;
  /** 因字段缺失/文件不存在被跳过的切块数 */
  skipped: number;
  /** 识别结果根本没产出切块 */
  empty: boolean;
}

export async function persistAnswerBlockCrops(
  params: PersistAnswerBlockCropsParams,
  db: DbAdapter = getMysqlDb()
): Promise<CropPersistenceStats> {
  const crops = params.crops ?? [];
  const sourceRecordId = String(params.sourceRecordId);

  // 五轮D1：无切块产出不再静默。扫描端/批量阅卷常因识别器版本差异（不支持 --crops-dir）
  // 致 blockCrops 恒空，留一行日志便于定位「有扫描无切块」而网阅队列为空的问题。
  if (crops.length === 0) {
    await db.run(
      "DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?",
      params.sourceType,
      sourceRecordId
    );
    console.warn(
      `[crop] 无切块产出 (cardId=${params.cardId}, source=${params.sourceType}:${sourceRecordId}); OCR 未返回 blockCrops，网阅队列将为空`
    );
    return { persisted: 0, skipped: 0, empty: true };
  }

  await db.run(
    "DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?",
    params.sourceType,
    sourceRecordId
  );

  const stats: CropPersistenceStats = { persisted: 0, skipped: 0, empty: false };
  const movedPaths: string[] = [];
  const targetDir = path.join(blockCropsDir, safeId(params.cardId), `${params.sourceType}_${safeId(sourceRecordId)}`);
  await mkdir(targetDir, { recursive: true });

  try {
    for (let index = 0; index < crops.length; index += 1) {
      const crop = crops[index];
      if (!crop?.path || !existsSync(crop.path) || !crop.blockId || !Array.isArray(crop.questionNumbers) || crop.questionNumbers.length === 0) {
        stats.skipped += 1;
        console.warn(
          `[crop] 跳过无效切块 #${index} (blockId=${crop?.blockId ?? "?"}, path=${crop?.path ?? "?"}, questionNumbers=${JSON.stringify(crop?.questionNumbers ?? null)})`
        );
        continue;
      }

      const id = randomUUID();
      const targetPath = path.join(targetDir, targetFileName(crop, index));
      // 安全（R07）：目标路径必须仍在「该卡/该记录」的切块目录内。
      // 清单里的页码/分段号参与文件名拼装，越界就等于让上传方决定服务端写文件的位置。
      // 源文件由服务端自己产生（识别器临时目录 / 扫描上传临时目录），远端已无法指定。
      if (!isInsideDir(targetDir, targetPath)) {
        stats.skipped += 1;
        console.warn(`[crop] 拒绝越出切块目录的目标路径 #${index} (target=${targetPath}, dir=${targetDir})`);
        continue;
      }
      await moveCropFile(path.resolve(crop.path), targetPath);
      movedPaths.push(targetPath);

      await db.run(
        `INSERT INTO answer_block_crops (
          id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
          block_id, block_title, block_type, page_number, segment_index,
          question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        id,
        params.cardId,
        params.examId ?? null,
        params.studentId ?? null,
        params.studentNumber ?? null,
        params.sourceType,
        sourceRecordId,
        crop.blockId,
        crop.blockTitle ?? "",
        crop.blockType,
        crop.pageNumber,
        crop.segmentIndex,
        JSON.stringify(crop.questionNumbers),
        JSON.stringify(crop.rect),
        targetPath,
        crop.widthPx,
        crop.heightPx,
        crop.dpi,
        "ready"
      );

      stats.persisted += 1;
    }
  } catch (error) {
    await Promise.all(movedPaths.map((targetPath) => unlink(targetPath).catch(() => {})));
    throw error;
  }

  return stats;
}

export async function getAnswerBlockCropFile(id: string, db: DbAdapter = getMysqlDb()): Promise<string | null> {
  if(process.env.PROJECTX_LEGACY_ONLY==="1"){const mod=await import("./LegacyPdfService");const file=await mod.legacyCropImage(id);if(file)return file;}
  const row = await db.get("SELECT image_path FROM answer_block_crops WHERE id = ?", id) as { image_path: string } | undefined;
  return row?.image_path ?? null;
}

export async function listAnswerBlockCropsForStudent(
  examId: number,
  studentId: number,
  db: DbAdapter = getMysqlDb()
): Promise<AnswerBlockCrop[]> {
  const rows = await db.all(
    `SELECT * FROM answer_block_crops
     WHERE exam_id = ? AND student_id = ?
     ORDER BY page_number, segment_index, block_title`,
    examId,
    studentId
  ) as CropRow[];
  return withQuestionScores(rows, examId, db);
}

export async function listReviewBlockCrops(
  params: {
    examId: number; blockId?: string; blockIds?: string[]; classId?: number; status?: string; cropId?: string;
    /** 逐生分配的可阅范围（评审 B1）：`{sql, params}` 以 `abc` 为切块表别名，null/缺省 = 不追加条件 */
    assignedSlice?: { sql: string; params: unknown[] } | null;
  },
  db: DbAdapter = getMysqlDb()
): Promise<AnswerBlockCrop[]> {
  const filters = ["abc.exam_id = ?"];
  const values: unknown[] = [params.examId];
  if (params.blockId) {
    filters.push("abc.block_id = ?");
    values.push(params.blockId);
  }
  // 安全 R03：题块级阅卷人的读取范围收敛（空集合 = 无任何题块可阅，必须返回空而非忽略条件）
  if (params.blockIds) {
    if (params.blockIds.length === 0) return [];
    filters.push(`abc.block_id IN (${params.blockIds.map(() => "?").join(",")})`);
    values.push(...params.blockIds);
  }
  // 安全 B1：题块之内再按逐生分配切片收口（清单里能看见的卷子 = 能领/能回看的卷子）
  if (params.assignedSlice) {
    filters.push(params.assignedSlice.sql);
    values.push(...params.assignedSlice.params);
  }
  if (params.status) {
    filters.push("abc.status = ?");
    values.push(params.status);
  }
  if (params.classId) {
    filters.push(examClassPredicate("abc.student_id", "abc.exam_id"));
    values.push(params.classId);
  }
  if (params.cropId) {
    filters.push("abc.id = ?");
    values.push(params.cropId);
  }

  const rows = await db.all(
    `SELECT abc.*, u.name AS student_name
     FROM answer_block_crops abc LEFT JOIN users u ON u.id=abc.student_id
     WHERE ${filters.join(" AND ")}
     ORDER BY abc.block_id, abc.student_number, abc.page_number, abc.segment_index`,
    ...values
  ) as CropRow[];
  return withQuestionScores(rows, params.examId, db);
}

/** 读取某考试各题块的 has_half_point，供打分面板判断 0.5 行 */
async function blockHasHalfPointMap(examId: number, db: DbAdapter): Promise<Map<string, number>> {
  const configs = await db.all(
    "SELECT block_id, has_half_point FROM block_grading_config WHERE exam_id = ?",
    examId
  ) as Array<{ block_id: string; has_half_point: number }>;
  const map = new Map<string, number>();
  for (const c of configs) map.set(c.block_id, c.has_half_point ?? 0);
  return map;
}

function blockMaxScoreFromCard(card: AnswerCard): Map<string, number> {
  const map = new Map<string, number>();
  for (const block of card.bodyBlocks) {
    let sum = 0;
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) sum += Number(def.score ?? 0);
    } else if (block.type === "subjective") {
      for (const q of block.questions ?? []) sum += Number(q.score ?? 0);
    }
    map.set(block.id, sum);
  }
  return map;
}

async function withQuestionScores(rows: CropRow[], examId: number, db: DbAdapter): Promise<AnswerBlockCrop[]> {
  if (rows.length === 0) return [];
  const studentIds = Array.from(new Set(rows.map((row) => row.student_id).filter((id): id is number => id != null)));
  const scoresByStudent = new Map<number, Array<{ question_number: number; score: number | null; max_score: number | null }>>();

  // Batch students instead of one SQL round trip per student. Chunk large exports.
  for (let offset = 0; offset < studentIds.length; offset += 500) {
    const ids = studentIds.slice(offset, offset + 500);
    const scores = await db.all(
      `SELECT student_id, question_number, score, max_score FROM question_scores
       WHERE exam_id = ? AND student_id IN (${ids.map(() => "?").join(",")})`,
      examId, ...ids
    ) as Array<{ student_id: number; question_number: number; score: number | null; max_score: number | null }>;
    for (const score of scores) {
      const group = scoresByStudent.get(score.student_id) ?? [];
      group.push(score); scoresByStudent.set(score.student_id, group);
    }
  }

  // PDF task boundaries can differ from the generated design card's block IDs.
  // Read the bound immutable PDF version once, rather than guessing its maximum from the design card.
  const pdfMax = new Map<string, number>();
  const pdfSerial = new Map<string, number>();
  const pdfScores=new Map<string,number|null>();
  if (process.env.PROJECTX_LEGACY_ONLY === "1") {
    const ids = rows.filter(row => row.source_type === "legacy_pdf").map(row => row.id);
    for (let offset = 0; offset < ids.length; offset += 500) {
      const group = ids.slice(offset, offset + 500);
      const refs = await db.all<{crop_id:string;question_id:string;template_id:string;serial_no:number|null;paper_score:number|null;paper_status:string}>(
        `SELECT m.crop_id,m.question_id,b.template_id,s.serial_no,m.score paper_score,m.status paper_status FROM legacy_pdf_marks m
         JOIN legacy_pdf_papers p ON p.id=m.paper_id JOIN legacy_pdf_batches b ON b.id=p.batch_id
         LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=b.exam_id
         WHERE m.crop_id IN (${group.map(() => "?").join(",")})`, ...group);
      for(const ref of refs){if(ref.serial_no!=null)pdfSerial.set(ref.crop_id,Number(ref.serial_no));pdfScores.set(ref.crop_id,ref.paper_status==="reviewed"&&ref.paper_score!=null?Number(ref.paper_score):null);}
      const templateIds = [...new Set(refs.map(x => x.template_id))];
      if (!templateIds.length) continue;
      const templates = await db.all<{id:string;definition_json:string}>(
        `SELECT id,definition_json FROM legacy_pdf_templates WHERE id IN (${templateIds.map(() => "?").join(",")})`, ...templateIds);
      const definitions = new Map(templates.map(t => {
        try { return [t.id, JSON.parse(t.definition_json).questions as Array<{questionId:string;maxScore:number}>] as const; }
        catch { return [t.id, [] as Array<{questionId:string;maxScore:number}>] as const; }
      }));
      for (const ref of refs) {
        const q = definitions.get(ref.template_id)?.find(q => q.questionId === ref.question_id);
        if (q && Number.isFinite(Number(q.maxScore))) pdfMax.set(ref.crop_id, Number(q.maxScore));
      }
    }
  }

  const halfMap = await blockHasHalfPointMap(examId, db);

  let blockMaxMap: Map<string, number> | null = null;
  try {
    const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
    if (exam?.card_id && rows.some(row => !pdfMax.has(row.id))) {
      const card = await new CardRepository().findById(exam.card_id);
      if (card) blockMaxMap = blockMaxScoreFromCard(card);
    }
  } catch { /* 题块权威满分缺失时退回历史行为 */ }

  return rows.map((row) => {
    const crop = toAnswerBlockCrop(row);
    crop.hasHalfPoint = halfMap.get(row.block_id) ?? 0;
    const questionSet = new Set(crop.questionNumbers.map((item) => String(item)));
    const scores = row.student_id != null
      ? (scoresByStudent.get(row.student_id) ?? []).filter((score) => questionSet.has(String(score.question_number)))
      : [];
    if (scores.length > 0) {
      crop.score = scores.reduce((sum, score) => sum + Number(score.score ?? 0), 0);
      crop.maxScore = scores.reduce((sum, score) => sum + Number(score.max_score ?? 0), 0);
    } else if (blockMaxMap) {
      crop.maxScore = blockMaxMap.get(row.block_id) ?? crop.maxScore ?? 0;
    }
    if (pdfMax.has(row.id)) crop.maxScore = pdfMax.get(row.id)!;
    if(pdfScores.has(row.id))crop.score=pdfScores.get(row.id)!;
    return { ...crop, serialNumber:pdfSerial.get(row.id)??null, studentName: row.student_name ?? null };
  });
}
