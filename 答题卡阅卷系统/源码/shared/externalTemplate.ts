/**
 * 外部答题卡模板适配器（方案十九：现成答题卡扫描 PDF 阅卷）。
 *
 * 输入是「外部答题卡配置草案」JSON（normalized_top_left 坐标），输出是原生识别器
 * 可直接消费的 LayoutDocument（毫米坐标）。转换内容：
 *  - 4 个角锚点 → 6 个 marker roles（middle-left/right 由上下角插值）
 *  - 归一化 rect → 毫米 rect（按页面 pt 尺寸换算，pt→mm = 25.4/72）
 *  - 考号 OMR 格 → student_digit 元素
 *  - 客观题选项 → objective_option 元素（blocks 里同时给 items 供切块 questionNumbers）
 *  - 主观题区域 → subjective blocks；同一题的多个 region 合成一个并集 frameRect 切块
 *  - 背面无学生标识：页型判定交给识别期（考号识别成功 = front）
 */
import type { LayoutDocument, PageLayout, LayoutElement, Rect, AnswerCard } from "./types";
import type {
  ExternalAnswerSheetTemplate,
  ExternalTemplatePage,
  ExternalTemplateQuestion,
  ExternalQuestionRegion
} from "./externalTemplateTypes";

const PT_PER_MM = 72 / 25.4;

export function isExternalTemplateProfile(profile: unknown): boolean {
  return Boolean(profile && typeof profile === "object" && (profile as Record<string, unknown>).externalTemplate);
}

function toMm(rect: { x: number; y: number; width: number; height: number }, page: { widthPt: number; heightPt: number }): Rect {
  const sx = page.widthPt / PT_PER_MM;
  const sy = page.heightPt / PT_PER_MM;
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

function roundMm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mmRect(rect: { x: number; y: number; width: number; height: number }, page: { widthPt: number; heightPt: number }): Rect {
  const mm = toMm(rect, page);
  return { x: roundMm(mm.x), y: roundMm(mm.y), width: roundMm(mm.width), height: roundMm(mm.height) };
}

type Point = { x: number; y: number };

function anchorCenters(page: ExternalTemplatePage): { topLeft: Point; topRight: Point; bottomLeft: Point; bottomRight: Point } {
  // anchorCandidates 顺序：TL, TR, BL, BR（草案 4 角按象限给出）
  const c = page.anchorCandidates;
  const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const pts = c.map((a) => center(mmRect(a.rect, page)));
  const sortedX = [...pts].sort((p, q) => p.x - q.x);
  const leftPair = sortedX.slice(0, 2).sort((p, q) => p.y - q.y);
  const rightPair = sortedX.slice(2).sort((p, q) => p.y - q.y);
  return {
    topLeft: leftPair[0],
    topRight: rightPair[0],
    bottomLeft: leftPair[1],
    bottomRight: rightPair[1]
  };
}

function buildMarkers(page: ExternalTemplatePage): PageLayout["markers"] {
  const { topLeft, topRight, bottomLeft, bottomRight } = anchorCenters(page);
  const mk = (role: string, x: number, y: number, side = 4): PageLayout["markers"][number] => ({
    role,
    rect: { x: x - side / 2, y: y - side / 2, width: side, height: side }
  });
  const middleLeft = { x: (topLeft.x + bottomLeft.x) / 2, y: (topLeft.y + bottomLeft.y) / 2 };
  const middleRight = { x: (topRight.x + bottomRight.x) / 2, y: (topRight.y + bottomRight.y) / 2 };
  return [
    mk("top-left", topLeft.x, topLeft.y),
    mk("top-right", topRight.x, topRight.y),
    mk("middle-left", middleLeft.x, middleLeft.y),
    mk("middle-right", middleRight.x, middleRight.y),
    mk("bottom-left", bottomLeft.x, bottomLeft.y),
    mk("bottom-right", bottomRight.x, bottomRight.y)
  ];
}

function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: roundMm(minX), y: roundMm(minY), width: roundMm(maxX - minX), height: roundMm(maxY - minY) };
}

/** 草案 questionId 形如 "q1".."q19"；题号取末尾数字。 */
function questionNumberOf(q: ExternalTemplateQuestion): number {
  const m = /(\d+)\s*$/.exec(String(q.questionId));
  return m ? Number(m[1]) : 0;
}

function displayLabel(q: ExternalTemplateQuestion, number: number): string {
  return q.displayNumber != null ? String(q.displayNumber) : String(number);
}

export function buildExternalLayout(card: AnswerCard, template: ExternalAnswerSheetTemplate): LayoutDocument {
  const warnings: string[] = [];
  const elements: LayoutElement[] = [];
  const pages: PageLayout[] = [];

  // 页序：front 在前，back 在后；pageNumber 供识别器按页查询
  const orderedPages = [...template.pages].sort((a, b) => {
    const rank = (p: ExternalTemplatePage) => (p.pageRole === "front" ? 0 : 1);
    return rank(a) - rank(b);
  });

  const pageByRole = new Map(orderedPages.map((p) => [p.pageRole, p]));
  const frontPage = pageByRole.get("front") ?? orderedPages[0];
  const widthMm = frontPage.widthPt / PT_PER_MM;
  const heightMm = frontPage.heightPt / PT_PER_MM;

  // —— 考号 student_digit 元素（仅 front）——
  const identity = template.identity;
  const identityPage = pageByRole.get(identity.pageRole) ?? frontPage;
  const digitCells = new Map<number, Map<number, Rect>>();
  for (const cell of identity.cells) {
    const col = Number(cell.column);
    const value = Number(cell.value);
    if (!Number.isInteger(col) || col < 1 || col > identity.length) continue;
    if (!Number.isInteger(value) || value < 0 || value > 9) continue;
    if (!digitCells.has(col)) digitCells.set(col, new Map());
    digitCells.get(col)!.set(value, mmRect(cell.rect, identityPage));
  }
  const studentDigitElements: LayoutElement[] = [];
  for (const [col, values] of digitCells) {
    for (const [digit, rect] of values) {
      studentDigitElements.push({ id: `id_${col}_${digit}`, type: "student_digit", digitIndex: col - 1, digit, rect });
    }
  }
  if (studentDigitElements.length === 0) {
    warnings.push("考号配置未产出任何有效 OMR 格");
  }

  // —— 题目按页分桶 ——
  const objectiveQuestions = template.questions.filter((q) => q.gradingType === "objective");
  const subjectiveQuestions = template.questions.filter((q) => q.gradingType === "teacher_score");

  orderedPages.forEach((page, pageIndex) => {
    const markers = buildMarkers(page);
    const pageElements: LayoutElement[] = [];
    const blocks: PageLayout["blocks"] = [];

    if (page.pageRole === identity.pageRole) {
      pageElements.push(...studentDigitElements);
    }

    // 客观题块：所有客观题放一个 block（识别器从 elements 读选项；blocks 只供切块清单）
    const objItems = objectiveQuestions
      .map((q) => {
        const number = questionNumberOf(q);
        const options = (q.options ?? []).map((o) => ({ label: o.label, rect: mmRect(o.rect, page) }));
        return { q, number, options };
      })
      .filter((item) => item.options.length > 0 && item.number > 0);
    // 只把「选项在本页」的题放进本页元素（草案客观题都在 front）
    const objOnPage = objItems.filter((item) => {
      const rect = item.options[0].rect;
      return rect.width > 0 && rect.height > 0 && pageHasRect(page, rect);
    });
    if (objOnPage.length > 0) {
      const blockId = "ext_obj";
      for (const item of objOnPage) {
        for (const opt of item.options) {
          pageElements.push({
            id: `opt_${item.number}_${opt.label}`,
            type: "objective_option",
            blockId,
            questionNumber: item.number,
            option: opt.label,
            rect: opt.rect
          });
        }
      }
      const frame = unionRect(objOnPage.flatMap((item) => item.options.map((o) => o.rect)));
      blocks.push({
        type: "objective",
        blockId,
        title: "客观题",
        rect: frame,
        frameRect: frame,
        rowMarkers: [],
        items: objOnPage.map((item) => ({
          questionNumber: item.number,
          options: item.options,
          labelX: 0,
          labelY: 0
        })),
        density: "normal"
      } as PageLayout["blocks"][number]);
    }

    // 主观题块：每题一个 block；多 region 合成一个并集切块（同一评分任务）
    for (const q of subjectiveQuestions) {
      const number = questionNumberOf(q);
      if (number <= 0) continue;
      const regions = (q.regions ?? []).filter((r) => r.pageRole === page.pageRole);
      if (regions.length === 0) continue;
      const rects = regions.map((r) => mmRect(r.rect, page));
      const frame = unionRect(rects);
      if (frame.width <= 0 || frame.height <= 0) continue;
      const blockId = `ext_subj_${number}`;
      blocks.push({
        type: "subjective",
        blockId,
        title: `第${displayLabel(q, number)}题`,
        rect: frame,
        frameRect: frame,
        questions: [{
          blockId,
          questionId: q.questionId,
          questionNumber: number,
          score: q.maxScore,
          style: "plain_subjective",
          kind: "plain_box",
          rect: frame,
          contentRect: frame,
          scoreCells: [],
          lineYs: [],
          blanks: [],
          images: []
        }]
      } as PageLayout["blocks"][number]);
    }

    pages.push({
      pageNumber: pageIndex + 1,
      width: page.widthPt / PT_PER_MM,
      height: page.heightPt / PT_PER_MM,
      markers,
      header: {
        id: `ext_header_${pageIndex + 1}`,
        idTextX: 20,
        idTextY: 12,
        qrCode: { ...({} as any), rect: { x: 58, y: 12, width: 18, height: 18 } }
      },
      panels: [],
      blocks,
      elements: pageElements
    });
  });

  const allElements = pages.flatMap((p) => p.elements);
  if (objectiveQuestions.some((q) => !(q.options ?? []).length)) {
    warnings.push("存在无选项配置的客观题");
  }

  return {
    cardId: card.id,
    width: roundMm(widthMm),
    height: roundMm(heightMm),
    recognitionInk: "legacy",
    pages,
    elements: allElements,
    warnings
  };
}

function pageHasRect(page: ExternalTemplatePage, rect: Rect): boolean {
  const w = page.widthPt / PT_PER_MM;
  const h = page.heightPt / PT_PER_MM;
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= w + 0.5 && rect.y + rect.height <= h + 0.5;
}
