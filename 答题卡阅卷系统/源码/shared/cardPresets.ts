import type { AnswerCard, CardPreset, CardProfile, SurveyMatrixConfig } from "./types";

export const DEFAULT_SURVEY_ROWS = ["语文", "数学", "英语", "道法", "历史", "地理", "生物", "音乐", "美术", "体育"];
export const DEFAULT_SURVEY_COLUMNS = ["总体评价", "工作态度", "教学水平", "老师到岗", "课堂纪律", "师生互动", "备课情况", "作业批改", "个别辅导"];
export const MAX_SURVEY_ROWS = 20;
export const MAX_SURVEY_COLUMNS = 12;

export const DEFAULT_SURVEY_PROFILE: CardProfile = {
  preset: "survey_matrix",
  survey: {
    rows: DEFAULT_SURVEY_ROWS,
    columns: DEFAULT_SURVEY_COLUMNS,
    optionLabels: ["A", "B", "C"],
    opinionTitle: "老师，我想对您说"
  }
};

export function presetOf(card: { profile?: CardProfile } | CardProfile | undefined): CardPreset {
  const value = card && "preset" in card ? card.preset : card?.profile?.preset;
  return value === "hn_regular" || value === "hn_standard" || value === "survey_matrix" ? value : "classic";
}

function cleanLabels(value: unknown, fallback: string[], max: number): string[] {
  if (!Array.isArray(value)) return fallback;
  const labels = value.map((item) => typeof item === "string" ? item.trim().slice(0, 40) : "").filter(Boolean).slice(0, max);
  return labels.length > 0 ? labels : fallback;
}

export function normalizeCardProfile(profile: unknown): CardProfile {
  const raw = profile && typeof profile === "object" ? profile as Record<string, unknown> : {};
  const preset = raw.preset === "hn_regular" || raw.preset === "hn_standard" || raw.preset === "survey_matrix" || raw.preset === "external"
    ? raw.preset
    : "classic";
  if (preset === "external") {
    // 外部模板原样保留（结构校验在导入 API 处完成），此处只负责透传。
    return { preset, externalTemplate: raw.externalTemplate };
  }
  if (preset !== "survey_matrix") return { preset };
  const survey = raw.survey && typeof raw.survey === "object" ? raw.survey as Record<string, unknown> : {};
  return {
    preset,
    survey: {
      rows: cleanLabels(survey.rows, DEFAULT_SURVEY_ROWS, MAX_SURVEY_ROWS),
      columns: cleanLabels(survey.columns, DEFAULT_SURVEY_COLUMNS, MAX_SURVEY_COLUMNS),
      optionLabels: ["A", "B", "C"],
      opinionTitle: typeof survey.opinionTitle === "string" ? survey.opinionTitle.slice(0, 80) : "老师，我想对您说"
    }
  };
}

export function normalizeCardProfileForCard(card: Pick<AnswerCard, "profile">): CardProfile {
  return normalizeCardProfile(card.profile);
}

export function isSurveyCard(card: Pick<AnswerCard, "profile">): boolean {
  return normalizeCardProfileForCard(card).preset === "survey_matrix";
}

export function surveyProfile(card: Pick<AnswerCard, "profile">): SurveyMatrixConfig {
  return normalizeCardProfileForCard(card).survey ?? DEFAULT_SURVEY_PROFILE.survey!;
}

export function surveyQuestionNumber(rowIndex: number, columnIndex: number, columnCount: number): number {
  return 1 + rowIndex * columnCount + columnIndex;
}

export type PrintTheme = { accent: string; text: string; marker: string };

export function printThemeFor(card: Pick<AnswerCard, "profile">): PrintTheme {
  switch (presetOf(card)) {
    case "hn_regular": return { accent: "#ff0000", text: "#222222", marker: "#000000" };
    case "hn_standard": return { accent: "#d91c72", text: "#222222", marker: "#000000" };
    case "survey_matrix": return { accent: "#333333", text: "#222222", marker: "#000000" };
    default: return { accent: "#333333", text: "#111111", marker: "#1f302c" };
  }
}
