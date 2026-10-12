import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { getMysqlDb, buildUpsertSQL, type DbAdapter } from "../../db";
import type { ExternalPageResult, ExternalTemplate } from "../../../shared/externalPaper";
import { batchDirectory, childPath, hashFile, pdfPages, renderPage, recognizeExternal, writeRuntimeTemplate } from "./files";

export interface ExternalBatchRow { id: string; exam_id: number; file_hash: string; template_hash: string; original_name: string; source_path: string; status: string; page_count: number; finished: number; error_text: string | null }
export interface ExternalPageRow { id: string; batch_id: string; page_index: number; result_json: string; paper_id: string | null }
export async function enqueueExternalPdf(examId: number, file: string, name: string, actorId: number, db = getMysqlDb()): Promise<ExternalBatchRow> {
  const fileHash = await hashFile(file);
  const count = await pdfPages(file);
  try {
    return await db.transactionWithNamedLock(`external-exam-${examId}`, 10000, async tx => {
      const config = await tx.get<{ template_hash: string }>("SELECT template_hash FROM external_paper_exams WHERE exam_id = ?", examId);
      if (!config) throw new Error("请先设置现成答题卡模板");
      const existing = await tx.get<ExternalBatchRow>("SELECT * FROM external_paper_batches WHERE exam_id = ? AND file_hash = ?", examId, fileHash);
      if (existing) { await rm(file, { force: true }); return existing; }
      const pending = await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM external_paper_batches WHERE status IN ('queued','processing')");
      if (Number(pending?.n ?? 0) >= 12) throw new Error("待处理文件较多，请稍后再上传");
      const id = randomUUID(), dir = batchDirectory(examId, id);
      await mkdir(dir, { recursive: true });
      const source = childPath(dir, "source.pdf");
      await rename(file, source);
      await tx.run("INSERT INTO external_paper_batches (id,exam_id,file_hash,template_hash,original_name,source_path,page_count,created_by) VALUES (?,?,?,?,?,?,?,?)",
        id, examId, fileHash, config.template_hash, name.slice(0, 255), source, count, actorId);
      return (await tx.get<ExternalBatchRow>("SELECT * FROM external_paper_batches WHERE id = ?", id))!;
    });
  } finally { await rm(file, { force: true }).catch(() => {}); }
}

/** Durable claims work across restarts/processes. No result exists only in a browser or an in-memory Map. */
export async function processNextExternalBatch(db: DbAdapter = getMysqlDb()): Promise<boolean> {
  const now = Date.now(), token = randomUUID();
  const row = await db.get<ExternalBatchRow>("SELECT * FROM external_paper_batches WHERE status = 'queued' OR (status = 'processing' AND lease_until < ?) ORDER BY created_at LIMIT 1", now);
  if (!row) return false;
  const claimed = await db.run("UPDATE external_paper_batches SET status='processing',worker_token=?,lease_until=?,error_text=NULL WHERE id=? AND (status='queued' OR (status='processing' AND lease_until < ?))",
    token, now + 180000, row.id, now);
  if (!claimed.changes) return true;
  const heartbeat = setInterval(() => { void db.run("UPDATE external_paper_batches SET lease_until=? WHERE id=? AND worker_token=? AND status='processing'", Date.now() + 180000, row.id, token).catch(() => {}); }, 30000);
  heartbeat.unref();
  try {
    const config = await db.get<{ template_json: string; template_hash: string }>("SELECT template_json,template_hash FROM external_paper_exams WHERE exam_id=?", row.exam_id);
    if (!config || config.template_hash !== row.template_hash) throw new Error("模板已变化，请重新建立本批次");
    const runtime = await writeRuntimeTemplate(row.exam_id, row.template_hash, JSON.parse(config.template_json) as ExternalTemplate);
    const upsert = buildUpsertSQL(db.dialect, "external_paper_pages", ["id", "batch_id", "page_index", "result_json"], ["batch_id", "page_index"], ["result_json"]);
    let failures = 0;
    for (let index = 1; index <= row.page_count; ++index) {
      const existing = await db.get<ExternalPageRow>("SELECT * FROM external_paper_pages WHERE batch_id=? AND page_index=?", row.id, index);
      if (existing) { if (JSON.parse(existing.result_json).status !== "ok") failures++; continue; }
      let result: ExternalPageResult;
      const dir = childPath(batchDirectory(row.exam_id, row.id), `page-${index}`);
      try {
        const image = await renderPage(row.source_path, index, childPath(dir, "source"));
        result = await recognizeExternal(image, runtime, dir);
      } catch (error) {
        result = { status: "failed", message: error instanceof Error ? error.message : "该页处理失败", questions: [], crops: [] };
      }
      if (result.status !== "ok") failures++;
      await db.transaction(async tx => {
        const lease = await tx.run("UPDATE external_paper_batches SET lease_until=?,finished=? WHERE id=? AND worker_token=? AND status='processing'",
          Date.now() + 180000, index, row.id, token);
        if (!lease.changes) throw new Error("处理任务已由其他进程接管");
        await tx.run(upsert, `${row.id}_${index}`, row.id, index, JSON.stringify(result));
      });
    }
    await db.run("UPDATE external_paper_batches SET status=?,finished=page_count,worker_token=NULL,lease_until=0 WHERE id=? AND worker_token=?", failures ? "needs_review" : "ready", row.id, token);
  } catch (error) {
    await db.run("UPDATE external_paper_batches SET status='error',error_text=?,worker_token=NULL,lease_until=0 WHERE id=? AND worker_token=?", error instanceof Error ? error.message : "扫描处理失败", row.id, token);
  } finally { clearInterval(heartbeat); }
  return true;
}
export function startExternalPaperWorker(): () => void {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await processNextExternalBatch(); } catch (error) { console.error("[external-paper] worker error", error instanceof Error ? error.message : "unknown"); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 1500); timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
