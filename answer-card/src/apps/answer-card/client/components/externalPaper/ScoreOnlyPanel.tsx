import React, { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../../auth/api";
import { ExternalPaperImage } from "./ExternalPaperImage";
import { Button } from "../ui/v2";
interface Paper { id: string; questionNumber: number; maxScore: number; step: number; claimCount: number; reviewRound: number; score: number | null; status: string }
export function ScoreOnlyPanel({ examId, blockId, onBack }: { examId: number; blockId: string; onBack: () => void }) {
  const question = Number(blockId.split("_q")[1]), base = `/api/external-paper/exams/${examId}`;
  const [current, setCurrent] = useState<Paper | null>(null), [score, setScore] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [history, setHistory] = useState<Paper[]>([]), [zoom, setZoom] = useState(100);
  const saving = useRef(false), held = useRef<Paper | null>(null), input = useRef<HTMLInputElement>(null);
  const pendingRequest = useRef<{ payload: string; id: string } | null>(null);
  const historyLoad = useCallback(async () => { const r = await fetchJson<{ rows: Paper[] }>(`${base}/questions/${question}/history`); setHistory(r.rows); }, [base, question]);
  const load = useCallback(async (excludeCropId?: string) => {
    setBusy(true); setError("");
    try {
      const r = await fetchJson<{ current: Paper | null; message?: string }>(`${base}/questions/${question}/claim`, { method: "POST", body: JSON.stringify({ excludeCropId }) });
      setCurrent(r.current); held.current = r.current; setScore(""); pendingRequest.current = null;
      setMessage(r.current ? "" : r.message ?? "当前没有待批答卷");
      await historyLoad(); setTimeout(() => input.current?.focus(), 0);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [base, question, historyLoad]);
  useEffect(() => { void load(); return () => {
    const c = held.current;
    if (c?.status === "ready" && !saving.current) void fetchJson(`${base}/crops/${c.id}/release`, { method: "POST", body: JSON.stringify({ claimCount: c.claimCount }) }).catch(() => {});
  }; }, [load, base]);
  useEffect(() => {
    if (!current || current.status !== "ready") return;
    const timer = setInterval(() => { void fetchJson(`${base}/crops/${current.id}/heartbeat`, { method: "POST", body: JSON.stringify({ claimCount: current.claimCount }) }).catch((e: any) => setError(`${e.message}。输入仍保留，请勿关闭本页。`)); }, 30000);
    return () => clearInterval(timer);
  }, [base, current]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (score.trim() !== "" || saving.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before);
  }, [score]);
  async function submit() {
    if (!current || saving.current || busy) return;
    const n = score.trim() === "" ? NaN : Number(score);
    if (!Number.isFinite(n) || n < 0 || n > current.maxScore || Math.abs(n / current.step - Math.round(n / current.step)) > 1e-8) { setError(`请输入 0—${current.maxScore} 分，最小单位 ${current.step} 分；空白不等于 0 分。`); return; }
    const body = { score: n, claimCount: current.claimCount, ...(current.status === "reviewed" ? { editRound: current.reviewRound } : {}) };
    const payload = JSON.stringify([current.id, body]);
    if (pendingRequest.current?.payload !== payload) pendingRequest.current = { payload, id: crypto.randomUUID() };
    saving.current = true; setBusy(true); setError("");
    try {
      await fetchJson(`${base}/crops/${current.id}/score`, { method: "POST", body: JSON.stringify({ ...body, requestId: pendingRequest.current.id }) });
      held.current = null; setCurrent(null); setScore(""); setMessage("已保存");
      // Advance only after the server has committed the score. A retry uses the same request ID.
      saving.current = false; await load();
    } catch (e: any) { setError(`${e.message}。当前输入已保留，可重试保存。`); }
    finally { saving.current = false; setBusy(false); }
  }
  async function leave(next: () => void | Promise<void>) {
    if (busy || saving.current) return;
    if (score.trim() && !window.confirm("当前分数尚未保存，确定放弃这次输入吗？")) return;
    setBusy(true);
    try { if (current?.status === "ready") await fetchJson(`${base}/crops/${current.id}/release`, { method: "POST", body: JSON.stringify({ claimCount: current.claimCount }) }); held.current = null; setScore(""); await next(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="p-4 space-y-4">
    <header className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={busy} onClick={() => void leave(onBack)}>返回题目</Button><h2 className="text-xl font-semibold">第 {question} 题{current ? ` · 满分 ${current.maxScore} 分` : ""}</h2><span>{current?.status === "reviewed" ? "修改本人已批分数" : "只需输入分数"}</span></header>
    {error && <p role="alert" className="rounded border p-3">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="flex flex-wrap items-center gap-3 sticky top-0 z-10 bg-white border rounded p-3">
      <label>得分 <input ref={input} aria-label="得分" className="border rounded p-2 w-24 text-xl" inputMode="decimal" type="text" value={score} disabled={!current || busy} onChange={e => setScore(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} /></label>
      <Button disabled={!current || busy || !score.trim()} onClick={() => void submit()}>{busy ? "请稍候…" : "保存并下一份"}</Button>
      <Button variant="outline" disabled={busy} onClick={() => void leave(() => load(current?.id))}>{current ? "暂跳这一份" : "领取待批答卷"}</Button>
      <label>图片大小 <select className="border rounded p-2" value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[75,100,125,150,200].map(n => <option key={n} value={n}>{n}%</option>)}</select></label>
      <span className="text-sm">输入完成后按回车；0 分需明确输入。</span>
    </div>
    {current && <div className="overflow-auto border rounded max-h-[72vh]"><ExternalPaperImage url={`${base}/crops/${current.id}/image`} alt={`第 ${question} 题完整作答图片`} style={{ width: `${zoom}%`, minWidth: 400 }} /></div>}
    <details><summary>最近已批 {history.length} 份（点击回看 / 改分）</summary><div className="flex flex-wrap gap-2 mt-3">{history.map((p, i) => <Button key={p.id} variant="outline" disabled={busy} onClick={() => void leave(() => { setCurrent(p); setScore(String(p.score ?? "")); setMessage(""); pendingRequest.current = null; })}>第 {i + 1} 份 · {p.score} 分</Button>)}</div></details>
  </section>;
}
