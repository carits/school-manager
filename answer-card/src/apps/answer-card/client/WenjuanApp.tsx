import { useEffect, useMemo, useState } from "react";
import { Download, LogOut, Plus, Upload } from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { apiUrl, fetchJson } from "./auth/api";
import { LoginPage } from "./components/LoginPage";

type Batch = { id: string; title: string; createdAt?: string; status: string; files: Array<{ id?: string; name: string; status: string; pages?: number; processedPages?: number; error?: string }>; pages: Array<{ fileName: string; page: number; status: string; error?: string }>; };

export default function WenjuanApp() {
  const { user, loading, logout } = useAuth();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [title, setTitle] = useState("初一年级评教评学问卷");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<File[]>([]);
  const base = useMemo(() => "/api/wenjuan", []);

  useEffect(() => {
    if (!user) return;
    const userId = user.id;
    let cancelled = false;
    async function loadBatches() {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        try {
          const { batches: serverBatches } = await fetchJson<{ batches: Batch[] }>(`${base}/batches`);
          if (cancelled) return;
          setBatches(serverBatches);
          const remembered = window.localStorage.getItem(`wenjuan:lastBatch:${userId}`);
          const restored = serverBatches.find((item) => item.id === remembered) ?? serverBatches[0] ?? null;
          if (restored) { setBatch(restored); window.localStorage.setItem(`wenjuan:lastBatch:${userId}`, restored.id); }
          setMessage("");
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
        }
      }
      if (!cancelled) setMessage(lastError instanceof Error ? `批次列表加载失败：${lastError.message}，请刷新重试` : "批次列表加载失败，请刷新重试");
    }
    void loadBatches();
    return () => { cancelled = true; };
  }, [base, user?.id]);

  useEffect(() => {
    if (!batch || (batch.status !== "processing" && batch.status !== "created")) return;
    const timer = window.setInterval(() => { void fetchJson<Batch>(`${base}/batches/${batch.id}`).then(setBatch).catch(() => undefined); }, 1200);
    return () => window.clearInterval(timer);
  }, [base, batch?.id, batch?.status]);

  async function newBatch() {
    setBusy(true); setMessage("");
    try { const result = await fetchJson<{ batchId: string }>(`${base}/batches`, { method: "POST", body: JSON.stringify({ title }) }); window.localStorage.setItem(`wenjuan:lastBatch:${user?.id}`, result.batchId); setBatch({ id: result.batchId, title, status: "created", files: [], pages: [] }); }
    catch (e) { setMessage(e instanceof Error ? e.message : "创建批次失败"); }
    finally { setBusy(false); }
  }
  async function upload() {
    if (!batch || !selected.length) { setMessage("请先新建批次并选择 PDF"); return; }
    setBusy(true); setMessage(""); const form = new FormData(); selected.forEach((file) => form.append("files", file));
    try { const response = await fetch(apiUrl(`${base}/batches/${batch.id}/uploads`), { method: "POST", body: form, credentials: "include" }); const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "上传失败"); setSelected([]); setBatch(await fetchJson<Batch>(`${base}/batches/${batch.id}`)); }
    catch (e) { setMessage(e instanceof Error ? e.message : "上传失败"); }
    finally { setBusy(false); }
  }
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-muted-foreground">正在检查登录状态…</div>;
  if (!user) return <LoginPage />;
  const completed = batch?.pages.filter((page) => page.status !== "error").length ?? 0;
  return <div className="min-h-[100dvh] bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"><div><h1 className="text-xl font-semibold">评教评学问卷</h1><p className="text-sm text-muted-foreground">上传扫描 PDF，使用 Linux 识别后导出 Excel</p></div><button className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted" onClick={() => void logout()}><LogOut size={15} />退出</button></div></header>
    <main className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <section className="rounded-lg border border-border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-end gap-3"><label className="flex min-w-[280px] flex-1 flex-col gap-1 text-sm"><span className="font-medium">批次名称</span><input className="rounded-md border border-border bg-background px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} /></label><button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={busy} onClick={() => void newBatch()}><Plus size={16} />新建批次</button></div>{batch && <p className="mt-3 text-xs text-muted-foreground">已自动恢复上次批次：{batch.title}（刷新页面不会丢失）</p>}{batches.length > 1 && <label className="mt-4 flex max-w-xl flex-col gap-1 text-sm"><span className="font-medium">历史批次（服务器保存）</span><select className="rounded-md border border-border bg-background px-3 py-2" value={batch?.id ?? ""} onChange={(e) => { const next = batches.find((item) => item.id === e.target.value); if (next) { setBatch(next); window.localStorage.setItem(`wenjuan:lastBatch:${user?.id}`, next.id); } }}>{batches.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status} · {item.files.map((file) => `${file.processedPages ?? 0}/${file.pages ?? "?"}`).join(", ")}</option>)}</select></label>}</section>
      {batch && <section className="rounded-lg border border-border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{batch.title}</h2><p className="text-sm text-muted-foreground">状态：{batch.status} · 已处理 {completed} 页</p></div><a className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted" href={apiUrl(`${base}/batches/${batch.id}/export`)}><Download size={16} />导出 Excel</a></div><div className="mt-4 flex flex-wrap items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"><Upload size={16} />选择 PDF（可多次追加）<input className="hidden" type="file" accept="application/pdf,.pdf" multiple onChange={(e) => setSelected(Array.from(e.target.files ?? []))} /></label><button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || !selected.length} onClick={() => void upload()}>上传并识别 {selected.length ? `(${selected.length})` : ""}</button>{selected.length > 0 && <span className="text-sm text-muted-foreground">{selected.map((f) => f.name).join("、")}</span>}</div>{message && <p className="mt-3 text-sm text-destructive-fg">{message}</p>}<div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="px-2 py-2">文件</th><th className="px-2 py-2">页数</th><th className="px-2 py-2">状态</th><th className="px-2 py-2">错误</th></tr></thead><tbody>{batch.files.map((file, index) => <tr className="border-b border-border/60" key={file.id ?? `${file.name}-${index}`}><td className="px-2 py-2">{file.name}</td><td className="px-2 py-2">{file.processedPages ?? 0}/{file.pages ?? "—"}</td><td className="px-2 py-2">{file.status}</td><td className="px-2 py-2 text-destructive-fg">{file.error ?? ""}</td></tr>)}</tbody></table></div></section>}
      {!batch && <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">先新建一个批次，再选择扫描得到的 PDF 文件。</div>}
    </main>
  </div>;
}

