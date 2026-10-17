import { createWriteStream, mkdirSync } from "node:fs";
import { once } from "node:events";
import { createDefaultCard } from "../源码/shared/defaultCard";
import { buildLayout } from "../源码/shared/layout";
import { createPdf } from "../源码/apps/answer-card/server/pdf";
import { DEFAULT_SURVEY_COLUMNS, DEFAULT_SURVEY_ROWS } from "../源码/shared/cardPresets";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function surveyCard() {
  const card = createDefaultCard("survey-test", "other", "A3");
  card.title = "评教评学测试";
  card.profile = {
    preset: "survey_matrix",
    survey: { rows: DEFAULT_SURVEY_ROWS, columns: DEFAULT_SURVEY_COLUMNS, optionLabels: ["A", "B", "C"], opinionTitle: "老师，我想对您说" }
  };
  card.studentInfo.showName = false;
  card.studentInfo.showClass = false;
  card.studentInfo.showStudentNumber = false;
  card.bodyBlocks = [{
    id: "survey_matrix",
    type: "objective",
    title: "评教评学（每格请选择一项）",
    questionStart: 1,
    questionCount: 90,
    optionCount: 3,
    mode: "single",
    scorePerQuestion: 0,
    density: "compact",
    optionLayout: "vertical",
    questions: []
  }, {
    id: "survey_opinion",
    type: "subjective",
    title: "老师，我想对您说",
    blockKind: "answer",
    questions: [{ id: "survey_opinion_question", number: "意见", score: 0, style: "plain_subjective", kind: "plain_box", minHeightMm: 220 }]
  }];
  return card;
}

async function writePdf(card: ReturnType<typeof createDefaultCard>, fileName: string) {
  const out = createWriteStream(fileName);
  const doc = createPdf(card);
  doc.pipe(out);
  doc.end();
  await once(out, "close");
}

const regular = createDefaultCard("hn-regular-test", "yuwen", "A3");
regular.title = "湖南普通考试测试";
regular.profile = { preset: "hn_regular" };
regular.studentInfo.studentNumberDigits = 6;
regular.studentInfo.showNotes = true;
regular.bodyBlocks = [];
const regularLayout = buildLayout(regular);
assert(regularLayout.width === 420 && regularLayout.height === 297, "hn_regular 纸张尺寸错误");
assert(regularLayout.pages[0].panels.length === 2, "hn_regular 应为 A3 双栏");
assert(regularLayout.pages[0].studentArea?.digitCells.length === 60, "hn_regular 应生成 6 位考号填涂区");

const survey = surveyCard();
const surveyLayout = buildLayout(survey);
const matrix = surveyLayout.pages[0].blocks.find((block) => block.type === "objective");
assert(surveyLayout.pages.length === 1, "survey_matrix 应为单页");
assert(surveyLayout.pages[0].panels.length === 1, "survey_matrix 应使用单版面");
assert(matrix?.type === "objective" && matrix.matrixPresentation, "survey_matrix 缺少矩阵元数据");
assert(matrix.items.length === 90, `survey_matrix 题格数量错误：${matrix.items.length}`);
assert(new Set(matrix.items.map((item) => item.questionNumber)).size === 90, "survey_matrix 题号不唯一");
assert(matrix.items.every((item) => item.options.length === 3), "survey_matrix 每格必须有 A/B/C 三个选项");
assert(matrix.items.every((item) => item.options.every((option) => option.rect.width > 0 && option.rect.height > 0)), "survey_matrix 选项坐标无效");

mkdirSync("测试数据/generated", { recursive: true });
await writePdf(regular, "测试数据/generated/hn-regular.pdf");
await writePdf(survey, "测试数据/generated/survey-matrix.pdf");
console.log("verify-hn-presets: 通过（A3 双栏 / 六位考号 / 单页 10×9 矩阵 / 三选一 ROI / PDF 输出）");
