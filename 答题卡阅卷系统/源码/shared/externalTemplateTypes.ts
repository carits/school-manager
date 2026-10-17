/**
 * 外部答题卡模板（草案配置）类型定义。
 * 坐标系：normalized_top_left（0-1 归一化，原点左上）。
 */
export type ExternalRect = { x: number; y: number; width: number; height: number };

export type ExternalAnchorCandidate = {
  center?: { x: number; y: number };
  rect: ExternalRect;
};

export type ExternalTemplatePage = {
  pageRole: "front" | "back" | string;
  sourcePdfPage: number;
  widthPt: number;
  heightPt: number;
  anchorCandidates: ExternalAnchorCandidate[];
  hasStudentIdentifierField?: boolean;
};

export type ExternalIdentityCell = {
  column: number;
  value: string;
  rect: ExternalRect;
};

export type ExternalTemplateIdentity = {
  pageRole: string;
  fieldType: "omr_digits" | string;
  length: number;
  storageType?: string;
  preserveLeadingZeros?: boolean;
  cells: ExternalIdentityCell[];
};

export type ExternalQuestionOption = {
  label: string;
  rect: ExternalRect;
};

export type ExternalQuestionRegion = {
  pageRole: string;
  order: number;
  rect: ExternalRect;
  displayMode?: string;
};

export type ExternalTemplateQuestion = {
  questionId: string;
  displayNumber?: string | number;
  gradingType: "objective" | "teacher_score" | string;
  maxScore: number;
  answer?: string[] | null;
  options?: ExternalQuestionOption[];
  regions?: ExternalQuestionRegion[];
  scoringRule?: Record<string, unknown>;
};

export type ExternalTemplatePairing = {
  suggestedMode: "interleaved_duplex" | string;
  confirmationRequired?: boolean;
  preserveSourceOrder?: boolean;
  backPageHasIndependentStudentId?: boolean;
  onAmbiguousOwnership?: string;
  autoDropBlankPages?: boolean;
};

export type ExternalAnswerSheetTemplate = {
  format: string;
  title?: string;
  coordinateSystem: "normalized_top_left" | string;
  totalMaxScore?: number;
  pages: ExternalTemplatePage[];
  identity: ExternalTemplateIdentity;
  pairing?: ExternalTemplatePairing;
  questions: ExternalTemplateQuestion[];
};

export type ExternalTemplateValidationError = { path: string; message: string };

/** 轻量结构校验（不引入运行时 schema 库，保持该层零依赖）。 */
export function validateExternalTemplate(input: unknown): { template?: ExternalAnswerSheetTemplate; errors: ExternalTemplateValidationError[] } {
  const errors: ExternalTemplateValidationError[] = [];
  const t = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const push = (path: string, message: string) => errors.push({ path, message });

  if (t.format !== "external-answer-sheet-design-seed-v1") {
    push("format", "format 必须是 external-answer-sheet-design-seed-v1");
  }
  if (t.coordinateSystem !== "normalized_top_left") {
    push("coordinateSystem", "coordinateSystem 必须是 normalized_top_left");
  }
  const pages = t.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    push("pages", "pages 必须是非空数组");
  } else {
    pages.forEach((page, i) => {
      const p = (page ?? {}) as Record<string, unknown>;
      if (!p.pageRole) push(`pages[${i}].pageRole`, "缺少 pageRole");
      if (!Array.isArray(p.anchorCandidates) || p.anchorCandidates.length < 4) {
        push(`pages[${i}].anchorCandidates`, "每页至少需要 4 个角锚点");
      }
      if (typeof p.widthPt !== "number" || p.widthPt <= 0) push(`pages[${i}].widthPt`, "widthPt 必须是正数");
      if (typeof p.heightPt !== "number" || p.heightPt <= 0) push(`pages[${i}].heightPt`, "heightPt 必须是正数");
    });
  }
  const identity = (t.identity ?? {}) as Record<string, unknown>;
  if (identity.fieldType !== "omr_digits") {
    push("identity.fieldType", "目前仅支持 omr_digits 考号识别");
  }
  if (!Array.isArray(identity.cells) || (identity.cells as unknown[]).length === 0) {
    push("identity.cells", "identity.cells 必须是非空数组");
  }
  const questions = t.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    push("questions", "questions 必须是非空数组");
  } else {
    questions.forEach((q, i) => {
      const item = (q ?? {}) as Record<string, unknown>;
      if (!item.questionId) push(`questions[${i}].questionId`, "缺少 questionId");
      if (typeof item.maxScore !== "number" || item.maxScore < 0) push(`questions[${i}].maxScore`, "maxScore 必须是非负数字");
      if (item.gradingType === "objective" && !Array.isArray(item.options)) {
        push(`questions[${i}].options`, "客观题必须提供 options");
      }
      if (item.gradingType === "teacher_score" && !Array.isArray(item.regions)) {
        push(`questions[${i}].regions`, "主观题必须提供 regions");
      }
    });
  }
  if (errors.length > 0) return { errors };
  return { template: input as ExternalAnswerSheetTemplate, errors: [] };
}
