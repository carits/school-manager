/** External sheets retain their printed geometry; never pass them through buildLayout. */
export interface PaperRect { x: number; y: number; width: number; height: number }
export interface PaperPoint { x: number; y: number }
export interface ExternalQuestion {
  number: number;
  type: "objective" | "subjective";
  maxScore: number;
  step: 1 | 0.5;
  requiredSelections?: number;
  options?: Array<{ label: string; page: number; rect: PaperRect }>;
  regions?: Array<{ page: number; rect: PaperRect }>;
}
export interface ExternalTemplate {
  version: 1;
  title: string;
  pages: Array<{ number: number; widthPt: number; heightPt: number; anchors: PaperPoint[]; verificationRects: PaperRect[] }>;
  identity: { page: number; digits: number; cells: Array<{ column: number; value: string; rect: PaperRect }>; headerRect: PaperRect };
  questions: ExternalQuestion[];
}
export interface ExternalObservation {
  questionNumber: number;
  selectedOptions: string[];
  status: "clear" | "blank" | "review";
  fillRatios?: number[];
  confirmedBy?: number;
}
export interface ExternalPageResult {
  status: "ok" | "failed";
  pageNumber?: number;
  studentNumber?: string | null;
  identityCertain?: boolean;
  quality?: number;
  margin?: number;
  rotation?: number;
  message?: string;
  questions: ExternalObservation[];
  crops: Array<{ questionNumber: number; pageNumber: number; path: string; width: number; height: number }>;
}
export type ExternalAnswerKey = Record<string, { options: string[]; partialScore?: number }>;
export const externalBlockId = (examId: number, number: number) => `external_${examId}_q${number}`;

const fail = (message: string): never => { throw new Error(message); };
function obj(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("模板必须是对象");
  return value as Record<string, any>;
}
function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fail("模板数值或分数超出允许范围");
  return value;
}
function array(value: unknown, min: number, max: number): any[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail("模板列表数量不正确");
  return value;
}
function rect(value: unknown): PaperRect {
  const r = obj(value);
  const out = { x: number(r.x, 0, 1), y: number(r.y, 0, 1), width: number(r.width, 0.001, 1), height: number(r.height, 0.001, 1) };
  if (out.x + out.width > 1.000001 || out.y + out.height > 1.000001) return fail("答题区域超出纸张边界");
  return out;
}
/** Reconstruct rather than spread: client-supplied filesystem paths are never accepted. */
export function validateExternalTemplate(value: unknown): ExternalTemplate {
  const t = obj(value);
  if (t.version !== 1 || typeof t.title !== "string" || !t.title.trim() || t.title.length > 150) return fail("模板格式或名称不正确");
  const pages = array(t.pages, 1, 8).map((p: any, index) => {
    if (p.number !== index + 1) return fail("模板页码必须从 1 连续编号");
    return { number: index + 1, widthPt: number(p.widthPt, 200, 1800), heightPt: number(p.heightPt, 200, 1800),
      anchors: array(p.anchors, 4, 4).map(a => ({ x: number(a.x, 0, 1), y: number(a.y, 0, 1) })),
      verificationRects: array(p.verificationRects, 1, 12).map(rect) };
  });
  const page = (v: unknown) => number(v, 1, pages.length, true);
  const i = obj(t.identity);
  const digits = number(i.digits, 1, 16, true);
  const cells = array(i.cells, digits * 10, digits * 10).map(c => {
    if (typeof c.value !== "string" || !/^[0-9]$/.test(c.value)) return fail("考号格必须为 0—9");
    return { column: number(c.column, 1, digits, true), value: c.value, rect: rect(c.rect) };
  });
  if (new Set(cells.map(c => `${c.column}:${c.value}`)).size !== cells.length) return fail("考号格重复");
  const questions = array(t.questions, 1, 200).map(q => {
    const common = { number: number(q.number, 1, 9999, true), maxScore: number(q.maxScore, 0.5, 1000), step: q.step === 0.5 ? 0.5 as const : 1 as const };
    if (common.maxScore / common.step % 1 !== 0) return fail("满分必须符合评分步长");
    if (q.type === "objective") {
      const options = array(q.options, 2, 10).map(o => {
        if (typeof o.label !== "string" || !/^[A-J]$/.test(o.label)) return fail("选项只支持 A—J");
        return { label: o.label, page: page(o.page), rect: rect(o.rect) };
      });
      if (new Set(options.map(o => o.label)).size !== options.length || new Set(options.map(o => o.page)).size !== 1) return fail("同题选项须在同一页且不得重复");
      return { ...common, type: "objective" as const, requiredSelections: number(q.requiredSelections, 1, options.length, true), options };
    }
    if (q.type !== "subjective") return fail("未知题型");
    const regions = array(q.regions, 1, 8).map(r => ({ page: page(r.page), rect: rect(r.rect) }));
    // The native worker joins multiple regions on one page. Cross-page composition is performed by the server.
    return { ...common, type: "subjective" as const, regions };
  });
  if (new Set(questions.map(q => q.number)).size !== questions.length) return fail("题号重复");
  return { version: 1, title: t.title.trim(), pages, identity: { page: page(i.page), digits, cells, headerRect: rect(i.headerRect) }, questions };
}
export function validateExternalKey(template: ExternalTemplate, value: unknown): ExternalAnswerKey {
  const input = obj(value), result: ExternalAnswerKey = {};
  for (const [key, v] of Object.entries(input)) {
    const q = template.questions.find(q => String(q.number) === key && q.type === "objective");
    if (!q) return fail("答案包含不属于本卷的题号");
    const item = obj(v), options = array(item.options, q.requiredSelections!, q.requiredSelections!);
    if (new Set(options).size !== options.length || options.some(o => typeof o !== "string" || !q.options!.some(p => p.label === o))) return fail(`第 ${key} 题答案选项不正确`);
    const partialScore = item.partialScore === undefined ? undefined : number(item.partialScore, 0, q.maxScore);
    if (partialScore !== undefined && q.requiredSelections === 1) return fail("单选题不设置漏选分");
    if (partialScore !== undefined && Math.abs(partialScore / q.step - Math.round(partialScore / q.step)) > 1e-8) return fail("漏选分必须符合该题计分单位");
    result[key] = { options: [...options].sort(), ...(partialScore === undefined ? {} : { partialScore }) };
  }
  return result;
}
/** Null means incomplete, never zero. A confirmed empty selection is a real blank answer. */
export function scoreExternalObjective(q: ExternalQuestion, observation: ExternalObservation | undefined, key: ExternalAnswerKey[string] | undefined): number | null {
  if (!key || !observation || observation.status === "review") return null;
  const selected = observation.selectedOptions;
  if (selected.length === key.options.length && selected.every(o => key.options.includes(o))) return q.maxScore;
  if (selected.length > 0 && selected.length < key.options.length && selected.every(o => key.options.includes(o))) return key.partialScore ?? 0;
  return 0;
}
export type PairingMode = "interleaved" | "fronts_first" | "backs_reverse";
/** These are proposals only. No ordinal-based ownership is committed before a person confirms it. */
export function proposePageGroups<T>(pages: T[], mode: PairingMode): T[][] {
  if (mode === "interleaved") return Array.from({ length: Math.ceil(pages.length / 2) }, (_, i) => pages.slice(i * 2, i * 2 + 2));
  if (pages.length % 2) return []; // A missing page makes the split point unknowable.
  const half = pages.length / 2;
  return pages.slice(0, half).map((p, i) => [p, pages[mode === "backs_reverse" ? pages.length - 1 - i : half + i]]);
}
export function assertScoreOnly(value: unknown, maxScore: number, step: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maxScore || Math.abs(value / step - Math.round(value / step)) > 1e-8) return fail(`请输入 0—${maxScore} 之间、以 ${step} 分为单位的分数`);
  return value;
}
