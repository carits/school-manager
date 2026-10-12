import express from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as XLSX from "xlsx";
import { dataDir } from "./storage";
import { recognizeAnswerCard } from "./recognition";

const execFileAsync = promisify(execFile);
const wenjuanDir = path.join(dataDir, "wenjuan");
const layoutFile = path.join(wenjuanDir, "initial-grade-2026.layout.json");
const batchesDir = path.join(wenjuanDir, "batches");
const activeJobs = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<(event: string, data: unknown) => void>>();

const subjects = ["语文", "数学", "英语", "道德与法治", "历史", "地理", "生物学", "音乐", "美术", "体育", "心理", "信息"];
const metrics = ["总体评价", "工作态度", "教学水平", "老师到岗", "课堂纪律", "备课情况", "作业批改"];
const classMetrics = ["总体评价", "工作责任", "关爱学生", "教育方法", "全面育人", "班风班纪", "家校联系", "老师到岗"];
const letters = ["A", "B", "C"];
const pt = (value: number) => value * 25.4 / 72;
const xPositions = [77.15856, 114.23456, 151.43456, 188.54456, 225.74456, 262.94456, 300.04456, 337.24456, 373.96456].map(pt);
const yA = [184.9418, 214.5818, 244.1018, 273.7718, 303.2918, 332.8118, 362.3318, 391.9718, 421.5118, 451.1518, 480.6718, 510.1918].map(pt);
const yB = [194.0618, 223.5818, 253.1318, 282.7718, 312.2918, 341.9318, 371.4518, 401.0918, 430.6318, 460.1518, 489.7918, 519.3118].map(pt);
const yC = [203.1818, 232.7018, 262.2518, 291.8918, 321.4118, 350.9318, 380.5718, 410.0918, 439.6318, 469.2718, 498.7918, 528.4318].map(pt);
const classYs = [642.4618, 651.5818, 660.5818].map(pt);

type Rect = { x: number; y: number; width: number; height: number };
type Definition = { questionNumber: number; section: string; subject?: string; metric: string; option: string; kind: "rating" | "choice" | "class" };
type Manifest = { id: string; ownerId?: number; title: string; createdAt: string; status: string; files: Array<{ id: string; name: string; path: string; pages?: number; processedPages?: number; status: string; error?: string }>; pages: Array<{ fileId: string; fileName: string; page: number; status: string; result?: Record<string, unknown>; error?: string }>; updatedAt: string };

function rect(x: number, y: number, width = 5, height = 3.4): Rect { return { x: x - width / 2, y: y - height / 2, width, height }; }

function definitions(): Definition[] {
  const out: Definition[] = [];
  let n = 1;
  for (let r = 0; r < subjects.length; r += 1) for (let c = 0; c < metrics.length; c += 1) { for (const option of letters) out.push({ questionNumber: n, section: "任课教师", subject: subjects[r], metric: metrics[c], option, kind: "rating" }); n += 1; }
  for (let r = 0; r < subjects.length; r += 1) for (const metric of ["有趣课堂", "有得课堂"]) out.push({ questionNumber: n++, section: "课堂选择", subject: subjects[r], metric, option: "A", kind: "choice" });
  for (const metric of classMetrics) { for (const option of letters) out.push({ questionNumber: n, section: "班主任", metric, option, kind: "class" }); n += 1; }
  return out;
}
const questionDefinitions = definitions();

async function ensureLayout(): Promise<void> {
  await mkdir(wenjuanDir, { recursive: true });
  const classDigits = () => {
    const elements: unknown[] = [];
    const xs = [168, 178, 188, 198];
    for (let index = 0; index < xs.length; index += 1) for (let digit = 0; digit <= 9; digit += 1) elements.push({ id: `class-digit-${index}-${digit}`, type: "student_digit", digitIndex: index, digit, rect: rect(xs[index], 39 + digit * 3.25, 4, 4) });
    return elements;
  };
  if (existsSync(layoutFile)) {
    const layout = JSON.parse(await readFile(layoutFile, "utf8")) as { pages?: Array<{ elements?: unknown[] }> };
    const page = layout.pages?.[0];
    if (page && !(page.elements ?? []).some((element) => (element as { type?: string }).type === "student_digit")) { page.elements = [...(page.elements ?? []), ...classDigits()]; await writeFile(layoutFile, JSON.stringify(layout), "utf8"); }
    return;
  }
  const elements: unknown[] = [];
  let n = 1;
  for (let r = 0; r < subjects.length; r += 1) {
    for (let c = 0; c < metrics.length; c += 1) {
      const ys = [yA[r], yB[r], yC[r]];
      for (let o = 0; o < letters.length; o += 1) elements.push({ id: `q-${n}-${letters[o]}`, type: "objective_option", blockId: "teacher-matrix", questionNumber: n, option: letters[o], rect: rect(xPositions[c], ys[o]) });
      n += 1;
    }
  }
  for (let r = 0; r < subjects.length; r += 1) for (let c = 0; c < 2; c += 1) elements.push({ id: `choice-${n}`, type: "objective_option", blockId: "class-choice", questionNumber: n++, option: "A", rect: rect(xPositions[7 + c], yA[r]) });
  for (let c = 0; c < classMetrics.length; c += 1) {
    const ys = classYs;
    for (let o = 0; o < letters.length; o += 1) elements.push({ id: `class-${n}-${letters[o]}`, type: "objective_option", blockId: "class-teacher", questionNumber: n, option: letters[o], rect: rect(xPositions[c], ys[o]) });
    n += 1;
  }
  const marker = (role: string, x: number, y: number) => ({ role, rect: rect(x, y, 4, 4) });
  const layout = { cardId: "wenjuan-chuyi-2026", recognitionInk: "legacy", width: 210, height: 297, pages: [{ pageNumber: 1, width: 210, height: 297, markers: [marker("top-left", 14.4, 9), marker("top-right", 196, 9), marker("middle-left", 14.4, 125), marker("middle-right", 196, 125), marker("bottom-left", 14.4, 242), marker("bottom-right", 196, 242)], elements: [...elements, ...classDigits()] }] };
  await writeFile(layoutFile, JSON.stringify(layout), "utf8");
}

function emit(batchId: string, event: string, data: unknown): void { for (const fn of listeners.get(batchId) ?? []) fn(event, data); }
async function manifestPath(id: string): Promise<string> { await mkdir(path.join(batchesDir, id), { recursive: true }); return path.join(batchesDir, id, "manifest.json"); }
async function readManifest(id: string): Promise<Manifest | null> { const p = path.join(batchesDir, id, "manifest.json"); try { return JSON.parse(await readFile(p, "utf8")) as Manifest; } catch { return null; } }
async function saveManifest(m: Manifest): Promise<void> { m.updatedAt = new Date().toISOString(); const target = path.join(batchesDir, m.id, "manifest.json"); const temp = `${target}.tmp`; await writeFile(temp, JSON.stringify(m, null, 2), "utf8"); await rename(temp, target); emit(m.id, "progress", batchView(m)); }
function visibleTo(m: Manifest, user: Express.Request["user"]): boolean { return !!user && (m.ownerId === user.id || (m.ownerId == null && user.role_name === "admin")); }
function batchView(m: Manifest) { return { id: m.id, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, status: m.status, files: m.files.map(({ id, name, pages, processedPages, status, error }) => ({ id, name, pages, processedPages, status, error })), pages: m.pages.map(({ fileId, fileName, page, status, error }) => ({ fileId, fileName, page, status, error })) }; }
function pageCount(text: string): number { const match = text.match(/^Pages:\s+(\d+)/m); return match ? Number(match[1]) : 0; }
function safeName(name: string): string { return name.replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(0, 160) || "问卷.pdf"; }

async function processBatch(batchId: string): Promise<void> {
  const m = await readManifest(batchId); if (!m) return;
  for (const file of m.files) if (file.status === "processing") { file.status = "queued"; file.processedPages = 0; m.pages = m.pages.filter((page) => page.fileId !== file.id); }
  m.status = "processing"; await saveManifest(m);
  for (const file of m.files) {
    if (file.status === "done") continue;
    try {
      const info = await execFileAsync("pdfinfo", [file.path]);
      const pages = pageCount(info.stdout); if (!pages || pages > 200) throw new Error("PDF 页数无效或超过 200 页");
      file.pages = pages; file.status = "processing"; await saveManifest(m);
      const pageDir = path.join(batchesDir, batchId, "pages", file.id); await mkdir(pageDir, { recursive: true });
      for (let p = 1; p <= pages; p += 1) {
        const prefix = path.join(pageDir, `page-${p}`);
        await execFileAsync("pdftoppm", ["-f", String(p), "-l", String(p), "-png", "-r", "300", file.path, prefix]);
        const image = `${prefix}-${String(p).padStart(3, "0")}.png`;
        try {
          const result = await recognizeAnswerCard({ identityMode: "legacy", imagePath: image, layoutPath: layoutFile, pageNumber: 1, dpi: 300 });
          const studentId = result.studentId as { status?: string; value?: string | null } | undefined;
          if (studentId?.status === "ok" && studentId.value) result.classCode = studentId.value;
          m.pages.push({ fileId: file.id, fileName: file.name, page: p, status: String(result.status ?? "ok"), result });
        } catch (error) {
          m.pages.push({ fileId: file.id, fileName: file.name, page: p, status: "error", error: error instanceof Error ? error.message : String(error) });
        }
        file.processedPages = p; await saveManifest(m);
      }
      file.status = "done"; await saveManifest(m);
    } catch (error) { file.status = "error"; file.error = error instanceof Error ? error.message : String(error); await saveManifest(m); }
  }
  // 追加上传可能发生在上一轮识别期间；重新读取 manifest，确保同一批次里的
  // 新文件不会被旧的内存快照遗漏。
  const latest = await readManifest(batchId);
  if (latest?.files.some((f) => f.status === "queued")) {
    await processBatch(batchId);
    return;
  }
  if (latest) {
    latest.status = latest.files.some((f) => f.status === "error") ? "completed_with_errors" : "completed";
    await saveManifest(latest);
  }
}

function startBatchJob(id: string): void {
  if (activeJobs.has(id)) return;
  const job = processBatch(id).finally(() => activeJobs.delete(id));
  activeJobs.set(id, job);
}

function summaryRows(m: Manifest) {
  const counts = new Map<string, { a: number; b: number; c: number; blank: number; forms: number }>();
  for (const page of m.pages) {
    const questions = Array.isArray(page.result?.questions) ? page.result?.questions as Array<Record<string, unknown>> : [];
    for (const q of questions) {
      const def = questionDefinitions.find((d) => d.questionNumber === Number(q.questionNumber)); if (!def) continue;
      const classCode = typeof page.result?.classCode === "string" && /^\d{4}$/.test(page.result.classCode) ? page.result.classCode : "";
      if (!classCode) continue;
      const key = `${classCode}|${def.section}|${def.subject ?? "班主任"}|${def.metric}`; const row = counts.get(key) ?? { a: 0, b: 0, c: 0, blank: 0, forms: 0 }; row.forms += 1;
      const selected = Array.isArray(q.selectedOptions) ? q.selectedOptions.map(String) : [];
      if (selected.length === 0) row.blank += 1; else { for (const s of selected) { if (s === "A") row.a += 1; else if (s === "B") row.b += 1; else if (s === "C") row.c += 1; } }
      counts.set(key, row);
    }
  }
  return [...counts.entries()].map(([key, v]) => { const [classCode, section, subject, metric] = key.split("|"); const valid = v.a + v.b + v.c; return { 班级: classCode, section, subject, metric, A: v.a, B: v.b, C: v.c, blank: v.blank, valid, satisfactionRate: valid ? (v.a + v.b * 0.5) / valid : 0, average: valid ? (v.a * 3 + v.b * 2 + v.c) / valid : 0 }; });
}

function exportWorkbook(m: Manifest): Buffer {
  const wb = XLSX.utils.book_new(); const rows = summaryRows(m);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ 批次: m.title, 状态: m.status, 文件数: m.files.length, 页面数: m.pages.length, 生成时间: new Date().toLocaleString("zh-CN") }]), "汇总");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "评价统计");
  const classTotals = new Map<string, { A: number; B: number; C: number; blank: number; valid: number }>();
  for (const row of rows) { const item = classTotals.get(row.班级) ?? { A: 0, B: 0, C: 0, blank: 0, valid: 0 }; item.A += row.A; item.B += row.B; item.C += row.C; item.blank += row.blank; item.valid += row.valid; classTotals.set(row.班级, item); }
  const classRows = [...classTotals.entries()].map(([班级, value]) => ({ 班级, ...value, satisfactionRate: value.valid ? (value.A + value.B * 0.5) / value.valid : 0, average: value.valid ? (value.A * 3 + value.B * 2 + value.C) / value.valid : 0 }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(classRows), "班级汇总");
  const detail = m.pages.map((p) => { const qs = Array.isArray(p.result?.questions) ? p.result?.questions as Array<Record<string, unknown>> : []; const values: Record<string, unknown> = { 班级: p.result?.classCode ?? "未识别班级", 文件: p.fileName, 页码: p.page, 状态: p.status, 识别消息: p.result?.message ?? p.error ?? "" }; for (const q of qs) values[`第${q.questionNumber}题`] = Array.isArray(q.selectedOptions) ? (q.selectedOptions as unknown[]).join("/") : ""; return values; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "问卷明细");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function createWenjuanRouter(): express.Router {
  const router = express.Router();
  const upload = multer({ dest: path.join(wenjuanDir, "_tmp"), limits: { files: 20, fileSize: 128 * 1024 * 1024 }, fileFilter: (_req, file, cb) => { if (file.mimetype === "application/pdf" || path.extname(file.originalname).toLowerCase() === ".pdf") cb(null, true); else cb(new Error("仅支持 PDF 文件")); } });
  router.post("/batches", async (req, res) => { await ensureLayout(); const id = randomUUID(); const m: Manifest = { id, ownerId: req.user?.id, title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 120) : "初一年级评教评学问卷", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "created", files: [], pages: [] }; await manifestPath(id); await saveManifest(m); res.json({ batchId: id, status: m.status }); });
  router.get("/batches", async (req, res) => { await mkdir(batchesDir, { recursive: true }); const entries = await readdir(batchesDir, { withFileTypes: true }); const batches: ReturnType<typeof batchView>[] = []; for (const entry of entries) { if (!entry.isDirectory()) continue; const m = await readManifest(entry.name); if (m && visibleTo(m, req.user)) { if (m.status === "processing" && m.files.some((file) => file.status !== "done")) startBatchJob(m.id); batches.push(batchView(m)); } } batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); res.json({ batches }); });
  router.post("/batches/:batchId/uploads", upload.array("files", 20), async (req, res) => { const id = String(req.params.batchId); const m = await readManifest(id); if (!m || !visibleTo(m, req.user)) { res.status(404).json({ message: "批次不存在" }); return; } const files = (req.files as Express.Multer.File[] | undefined) ?? []; if (!files.length) { res.status(400).json({ message: "请选择 PDF 文件" }); return; } for (const f of files) { const fileId = randomUUID(); const dir = path.join(batchesDir, id, "files"); await mkdir(dir, { recursive: true }); const target = path.join(dir, `${fileId}.pdf`); await rename(f.path, target); m.files.push({ id: fileId, name: safeName(f.originalname), path: target, status: "queued" }); } await saveManifest(m); startBatchJob(id); res.status(202).json({ batchId: id, status: "processing", files: files.length }); });
  router.get("/batches/:batchId", async (req, res) => { const m = await readManifest(String(req.params.batchId)); if (!m || !visibleTo(m, req.user)) { res.status(404).json({ message: "批次不存在" }); return; } if (m.status === "processing" && m.files.some((file) => file.status !== "done")) startBatchJob(m.id); res.json(batchView(m)); });
  router.get("/batches/:batchId/events", async (req, res) => { const id = String(req.params.batchId); const m = await readManifest(id); if (!m || !visibleTo(m, req.user)) { res.status(404).end(); return; } res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive"); const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }; send("progress", batchView(m)); const set = listeners.get(id) ?? new Set(); set.add(send); listeners.set(id, set); req.on("close", () => { set.delete(send); if (!set.size) listeners.delete(id); }); });
  router.get("/batches/:batchId/export", async (req, res) => { const m = await readManifest(String(req.params.batchId)); if (!m || !visibleTo(m, req.user)) { res.status(404).json({ message: "批次不存在" }); return; } const buffer = exportWorkbook(m); res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''wenjuan-${encodeURIComponent(m.title)}.xlsx`); res.send(buffer); });
  return router;
}

