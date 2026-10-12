import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, writeFile, statfs } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir } from "../../../apps/answer-card/server/storage";
import { resolveRecognizerExe } from "../../../apps/answer-card/server/recognition";
import type { ExternalTemplate, ExternalPageResult } from "../../../shared/externalPaper";
const exec = promisify(execFile);
export const EXTERNAL_MAX_PDF_BYTES = 128 * 1024 * 1024;
export const EXTERNAL_MAX_PAGES = 500;
export const externalRoot = path.join(dataDir, "external-paper");
export function childPath(root: string, ...parts: string[]): string {
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("文件路径不合法");
  return resolved;
}
export const templateDirectory = (examId: number, hash: string) => childPath(externalRoot, String(examId), "templates", hash);
export const batchDirectory = (examId: number, id: string) => childPath(externalRoot, String(examId), "batches", id);
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}
export async function pdfPages(file: string): Promise<number> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(5); await handle.read(header, 0, 5, 0);
    if (header.toString("ascii") !== "%PDF-") throw new Error("请上传有效 PDF 文件");
  } finally { await handle.close(); }
  const { stdout } = await exec("pdfinfo", [file], { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  if (/^Encrypted:\s+yes/m.test(stdout)) throw new Error("暂不支持加密 PDF，请使用未加密扫描文件");
  const count = Number(stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > EXTERNAL_MAX_PAGES) throw new Error(`PDF 必须为 1—${EXTERNAL_MAX_PAGES} 页`);
  return count;
}
export async function ensureExternalDiskBudget(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const fs = await statfs(dir);
  if (fs.bavail * fs.bsize < 1024 * 1024 * 1024) throw new Error("扫描存储剩余不足 1 GiB，已暂停渲染；请扩容或按学校保留策略归档后重试");
}
export async function renderPage(file: string, page: number, destination: string): Promise<string> {
  await ensureExternalDiskBudget(path.dirname(destination));
  // Bound the longest side before decoding, including PDFs with maliciously large MediaBoxes.
  await exec("pdftoppm", ["-gray", "-png", "-scale-to", "5000", "-f", String(page), "-l", String(page), "-singlefile", file, destination],
    { timeout: 45000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  return `${destination}.png`;
}
export async function writeRuntimeTemplate(examId: number, hash: string, template: ExternalTemplate): Promise<string> {
  const dir = templateDirectory(examId, hash);
  const file = childPath(dir, "runtime.json");
  const runtime = { ...template, pages: template.pages.map(p => ({ ...p, referencePath: childPath(dir, `page-${p.number}.png`) })) };
  await writeFile(file, JSON.stringify(runtime));
  return file;
}
export async function recognizeExternal(file: string, runtimePath: string, output: string): Promise<ExternalPageResult> {
  await mkdir(output, { recursive: true });
  let stdout: string;
  try {
    ({ stdout } = await exec(resolveRecognizerExe(), ["--external", "--image", file, "--layout", runtimePath, "--crops-dir", output],
      { timeout: 60000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }));
  } catch (error: any) {
    if (!error.killed && typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) stdout = error.stdout;
    else throw new Error(error.killed ? "本页识别超时，可重试本批次" : "识别器无法运行，请检查原生识别器及 --external 支持");
  }
  const result = JSON.parse(stdout) as ExternalPageResult;
  if (result.status !== "ok") return { status: "failed", message: result.message || "页面定位失败", quality: result.quality, margin: result.margin, questions: [], crops: [] };
  if (!Number.isInteger(result.pageNumber) || !Array.isArray(result.questions) || !Array.isArray(result.crops)) throw new Error("识别器返回格式不正确");
  for (const crop of result.crops) {
    if (!Number.isInteger(crop.questionNumber) || crop.path !== childPath(output, `q${crop.questionNumber}.png`)) throw new Error("识别器返回了非法切图路径");
  }
  return result;
}
export async function readStoredResult(file: string): Promise<ExternalPageResult> { return JSON.parse(await readFile(file, "utf8")); }
