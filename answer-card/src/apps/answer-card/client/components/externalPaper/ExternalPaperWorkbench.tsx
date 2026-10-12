import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, fetchJson } from "../../auth/api";
import { Button } from "../ui/v2";
import { ExternalPaperImage } from "./ExternalPaperImage";
import { WEEK7_CHINESE_TEMPLATE } from "../../../../../shared/externalPaperPreset";
import { proposePageGroups, validateExternalTemplate, type ExternalTemplate, type ExternalObservation, type ExternalAnswerKey } from "../../../../../shared/externalPaper";
interface Batch { id: string; name: string; status: string; pageCount: number; finished: number; error?: string }
interface Page { id: string; index: number; status: string; sheetId?: string | null; pageNumber?: number; studentNumber?: string; identityCertain?: boolean; message?: string }
interface Sheet { id: string; studentNumber: string; version: number; observations: ExternalObservation[]; total: number | null; scores: { number: number; type: string; score: number | null; maxScore: number }[]; pages: { id: string; batchId: string; index: number; pageNumber: number }[] }
type Assignments = Record<string, { teacherIds: number[]; classIds: number[] }>;
interface Overview { configured: boolean; classes?: {id:number;name:string}[]; template?: ExternalTemplate; answerKey?: ExternalAnswerKey; assignments?: Assignments; batches?: Batch[]; counts?: { total: number; reviewed: number } }
const labels: Record<string, string> = { queued: "排队中", processing: "正在识别", ready: "等待配页确认", needs_review: "部分页面需重扫", error: "处理失败" };
export function ExternalPaperWorkbench({ examId }: { examId: number }) {
  const base = `/api/external-paper/exams/${examId}`;
  const [overview, setOverview] = useState<Overview | null>(null), [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const [templateText, setTemplateText] = useState(JSON.stringify(WEEK7_CHINESE_TEMPLATE, null, 2)), [templateFile, setTemplateFile] = useState<File | null>(null), [scanFile, setScanFile] = useState<File | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({}), [partial, setPartial] = useState<Record<string, number>>({}), [assignments, setAssignments] = useState<Assignments>({});
  const [teachers, setTeachers] = useState<{ id: number; name: string }[]>([]), [batchId, setBatchId] = useState(""), [batch, setBatch] = useState<(Batch & { pages: Page[] }) | null>(null);
  const [mode, setMode] = useState<"interleaved" | "fronts_first" | "backs_reverse">("interleaved"), [checkedOrder, setCheckedOrder] = useState(false), [selected, setSelected] = useState<string[]>([]), [student, setStudent] = useState(""), [supplement, setSupplement] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]), [sheetCount, setSheetCount] = useState(0), [offset, setOffset] = useState(0), [review, setReview] = useState<{ sheet: Sheet; question: number } | null>(null), [selection, setSelection] = useState<string[]>([]);
  const [preview, setPreview] = useState<Page | null>(null), [templatePage, setTemplatePage] = useState(1);
  const draftLoaded = useRef(false), mutation = useRef(false);
  const refresh = useCallback(async () => {
    const data = await fetchJson<Overview>(`${base}/status`); setOverview(data);
    if (data.configured && !draftLoaded.current) {
      setTemplateText(JSON.stringify(data.template, null, 2)); setAssignments(data.assignments ?? {});
      setKeys(Object.fromEntries(Object.entries(data.answerKey ?? {}).map(([k, v]) => [k, v.options.join("")])));
      setPartial(Object.fromEntries(Object.entries(data.answerKey ?? {}).map(([k, v]) => [k, v.partialScore ?? 0]))); draftLoaded.current = true;
    }
    if (data.configured) {
      const s = await fetchJson<{ rows: Sheet[]; count: number }>(`${base}/sheets?offset=${offset}`); setSheets(s.rows); setSheetCount(s.count);
    }
  }, [base, offset]);
  const refreshBatch = useCallback(async () => { if (batchId) setBatch(await fetchJson(`${base}/batches/${batchId}`)); }, [base, batchId]);
  useEffect(() => { draftLoaded.current = false; setBatchId(""); setBatch(null); setSelected([]); setOffset(0); }, [examId]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { void fetchJson<{ data: { id: number; name: string }[] }>(`/api/review-assign/exams/${examId}/eligible-teachers`).then(r => setTeachers(r.data)).catch(e => setError(e.message)); }, [examId]);
  useEffect(() => { void refreshBatch().catch(e => setError(e.message)); }, [refreshBatch]);
  useEffect(() => {
    const timer = setInterval(() => { if (!mutation.current) { void refresh().catch(e => setError(e.message)); void refreshBatch().catch(e => setError(e.message)); } }, 5000);
    return () => clearInterval(timer);
  }, [refresh, refreshBatch]);
  async function perform(fn: () => Promise<void>, success: string) {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError(""); setNote("");
    try { await fn(); setNote(success); await refresh(); await refreshBatch(); }
    catch (e: any) { setError(e.message); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function uploadTemplate() {
    if (!templateFile) throw new Error("先选择原始空白答题卡 PDF；不是学生作答扫描件。");
    const t = validateExternalTemplate(JSON.parse(templateText)), data = new FormData(); data.set("template", JSON.stringify(t)); data.set("file", templateFile);
    await fetchJson(`${base}/template`, { method: "POST", body: data }); draftLoaded.current = false;
  }
  const t = overview?.template;
  // Preserve every physical index, including failed/missing pages. Never pair after filtering errors out.
  const slots: Page[] = batch ? Array.from({ length: batch.pageCount }, (_, i) => batch.pages.find(p => p.index === i + 1) ?? { id: `missing-${i}`, index: i + 1, status: "missing" }) : [];
  const groups = proposePageGroups(slots, mode);
  const proposed = groups.filter(g => g.length === 2 && g.every(p => p.status === "ok" && !p.sheetId) && new Set(g.map(p => p.pageNumber)).size === 2 && g.some(p => p.pageNumber === t?.identity.page && p.identityCertain && p.studentNumber));
  const isBatchFinished = batch && !["queued", "processing"].includes(batch.status) && batch.finished === batch.pageCount;
  function togglePage(p: Page) {
    setSelected(ids => ids.includes(p.id) ? ids.filter(v => v !== p.id) : [...ids, p.id]);
    if (p.pageNumber === t?.identity.page) setStudent(p.studentNumber?.replace(/\?/g, "") ?? "");
  }
  async function confirmOne() {
    if (!selected.length || !checkedOrder) throw new Error("请选中页面，核对考号，并勾选已核对归属。");
    await fetchJson(`${base}/sheets`, { method: "POST", body: JSON.stringify({ pageIds: selected, studentNumber: student.trim(), confirmed: true, ...(supplement ? { existingSheetId: supplement } : {}) }) }); setSelected([]); setStudent(""); setSupplement("");
  }
  async function confirmProposals() {
    if (!checkedOrder || !isBatchFinished || t?.pages.length !== 2) throw new Error("请先核对扫描顺序。批量配页仅适用于已处理完的双页模板。");
    const failures: string[] = []; let done = 0;
    for (const group of proposed) {
      const first = group.find(p => p.pageNumber === t!.identity.page)!;
      try { await fetchJson(`${base}/sheets`, { method: "POST", body: JSON.stringify({ pageIds: group.map(p => p.id), studentNumber: first.studentNumber, confirmed: true }) }); done++; }
      catch (e: any) { failures.push(`扫描第 ${group.map(p => p.index).join("、")} 页：${e.message}`); }
    }
    if (failures.length) throw new Error(`已确认 ${done} 份；以下未处理，不会顺移其他页面：${failures.slice(0, 8).join("；")}`);
  }
  async function saveAnswers() {
    const value: ExternalAnswerKey = {};
    for (const q of t?.questions.filter(q => q.type === "objective") ?? []) {
      const text = (keys[q.number] ?? "").toUpperCase().replace(/[\s,，]/g, "");
      if (text) value[String(q.number)] = { options: text.split(""), ...(q.requiredSelections! > 1 ? { partialScore: partial[q.number] ?? 0 } : {}) };
    }
    await fetchJson(`${base}/answers`, { method: "PUT", body: JSON.stringify(value) });
  }
  async function exportCsv() {
    const r = await authFetch(`${base}/export`); if (!r.ok) throw new Error("导出失败，请刷新后重试");
    const url = URL.createObjectURL(await r.blob()), a = document.createElement("a"); a.href = url; a.download = `考试${examId}-当前成绩.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const box = "border rounded-lg p-4 space-y-3", field = "border rounded px-2 py-1";
  return <div className="space-y-5">
    <header><h2 className="text-xl font-semibold">现成答题卡 · 扫描阅卷</h2><p className="mt-1">上传学校现有答题卡，不重新排版。先确认归属，再识别计分和分题批改。</p></header>
    {error && <p role="alert" className="border rounded p-3 whitespace-pre-wrap">{error}</p>}{note && <p role="status">{note}</p>}
    {!overview ? <p>正在读取考试…</p> : <>
      <details className={box} open={!overview.configured}><summary className="font-semibold">{overview.configured ? `答题卡：${t!.title} · ${t!.questions.reduce((s,q) => s+q.maxScore,0)} 分` : "设置答题卡（本卷已预置题号和区域）"}</summary>
        <p>先选择原始空白 PDF。已上传学生扫描件后模板锁定，不会重切或删除已批答案。其他版式可导入或编辑下方区域设置。</p>
        <input type="file" accept="application/pdf,.pdf" disabled={busy || !!overview.batches?.length} onChange={e => setTemplateFile(e.target.files?.[0] ?? null)} aria-label="空白答题卡 PDF" />
        <Button disabled={busy || !!overview.batches?.length} onClick={() => void perform(uploadTemplate, "模板已保存，请检查叠加框后上传少量扫描件试识别")}>保存答题卡模板</Button>
        <details><summary>模板设置（题号、满分、考号位数及作答区域）</summary><p>坐标为页面比例，0—1。每题可配置多个区域；同题所有区域只产生一个评分任务。</p>
          <input type="file" accept=".json,application/json" disabled={busy || !!overview.batches?.length} onChange={e => { const f=e.target.files?.[0]; if(f) void f.text().then(s => { validateExternalTemplate(JSON.parse(s));setTemplateText(s); }).catch(e => setError(e.message)); }} aria-label="导入模板设置" />
          <textarea className="border rounded w-full h-64 font-mono text-sm" aria-label="模板区域设置" value={templateText} disabled={busy || !!overview.batches?.length} onChange={e => setTemplateText(e.target.value)} />
        </details>
        {t && <><label>核对区域 <select className={field} value={templatePage} onChange={e => setTemplatePage(Number(e.target.value))}>{t.pages.map(p => <option key={p.number} value={p.number}>第 {p.number} 页</option>)}</select></label><ExternalPaperImage url={`${base}/template/${templatePage}/image`} alt="空白模板及识别区域" style={{ maxWidth: 1000 }}>
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>{t.questions.flatMap(q => q.type === "objective" ? q.options!.map(o => ({ page:o.page,rect:o.rect,n:q.number })) : q.regions!.map(r => ({...r,n:q.number}))).filter(r => r.page === templatePage).map((r,i) => <g key={i}><rect x={r.rect.x*1000} y={r.rect.y*1000} width={r.rect.width*1000} height={r.rect.height*1000} fill="none" stroke="currentColor" strokeWidth="1"/><text x={r.rect.x*1000} y={r.rect.y*1000+11} fontSize="11">{r.n}</text></g>)}</svg>
        </ExternalPaperImage></>}
      </details>
      {overview.configured && <>
        <div className="flex flex-wrap gap-3 items-center"><strong>主观题已批 {overview.counts?.reviewed ?? 0} / {overview.counts?.total ?? 0}</strong><span>已确认答卷 {sheetCount} 份</span><Button variant="outline" disabled={busy} onClick={() => void perform(exportCsv, "已导出数据库当前成绩；未完成总分留空")}>导出当前成绩</Button></div>
        <section className={box}><h3 className="font-semibold">上传扫描 PDF</h3><p>建议整幅双面相邻扫描，关闭自动删空白页；支持单个文件最多 128 MiB、500 页，多个文件依次加入。</p>
          <input type="file" accept="application/pdf,.pdf" aria-label="学生扫描 PDF" disabled={busy} onChange={e => setScanFile(e.target.files?.[0] ?? null)} />
          <Button disabled={busy || !scanFile} onClick={() => void perform(async () => { const data = new FormData();data.set("file",scanFile!);const r = await fetchJson<Batch>(`${base}/pdf`,{method:"POST",body:data});setBatchId(r.id);setSelected([]);setCheckedOrder(false); }, "已接收扫描文件，重复文件会返回原批次")}>上传并识别</Button>
          <div className="space-y-2">{overview.batches?.map(b => <div key={b.id} className="flex flex-wrap items-center gap-3"><span>{b.name} · {labels[b.status] ?? b.status} · {b.finished}/{b.pageCount} 页</span><Button variant="outline" onClick={() => {setBatchId(b.id);setSelected([]);setPreview(null);setCheckedOrder(false);}}>查看 / 配页</Button>{["error","needs_review"].includes(b.status) && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {await fetchJson(`${base}/batches/${b.id}/retry`,{method:"POST",body:"{}"});},"已重试未成功页面，已确认及已批成绩保留")}>重试失败页</Button>}{b.error && <span role="alert">{b.error}</span>}</div>)}</div>
        </section>
        {batch && <section className={box}><h3 className="font-semibold">核对配页：{batch.name}</h3><p>作文页没有考号，系统只能确认页型，不能猜测打乱后的归属。以下配对以你确认的扫描顺序为依据，异常页不会被删除后顺移。</p>
          <label>扫描顺序 <select className={field} value={mode} onChange={e => {setMode(e.target.value as typeof mode);setCheckedOrder(false);}}><option value="interleaved">同一张纸正反面相邻</option><option value="fronts_first">先全部正面，再全部背面（同序）</option><option value="backs_reverse">先全部正面，再全部背面（逆序）</option></select></label>
          <div className="max-h-60 overflow-auto border rounded"><table className="w-full text-left"><thead><tr><th>扫描页</th><th>识别页型 / 考号</th><th>处理</th></tr></thead><tbody>{batch.pages.map(p => <tr key={p.id}><td><label><input type="checkbox" disabled={busy || !!p.sheetId || p.status !== "ok"} checked={selected.includes(p.id)} onChange={() => togglePage(p)} /> 第 {p.index} 页</label></td><td>{p.status === "ok" ? `模板第 ${p.pageNumber} 页 · ${p.studentNumber ?? "无考号栏"}` : p.message ?? "待处理"}</td><td><Button size="sm" variant="outline" onClick={() => setPreview(p)}>看原卷</Button>{p.sheetId ? "已配入答卷" : "待确认"}</td></tr>)}</tbody></table></div>
          {preview && <details open><summary>扫描第 {preview.index} 页（校正后的完整图）</summary><ExternalPaperImage url={`${base}/batches/${batch.id}/pages/${preview.index}/image`} alt={`扫描第${preview.index}页`} style={{maxWidth:1000}} /></details>}
          <p>建议配对：{groups.slice(0,20).map(g => g.map(p => p.index).join("＋")).join("；")}{groups.length > 20 ? "；其余按同一规则" : ""}。当前可批量确认 {proposed.length} 份，其余须人工处理。</p>
          <label className="block"><input type="checkbox" checked={checkedOrder} onChange={e => setCheckedOrder(e.target.checked)} /> 我已核对扫描顺序、正反面对应关系和考号；缺页或乱序的答卷将单独处理。</label>
          <div className="flex flex-wrap gap-3"><Button disabled={busy || !checkedOrder || !isBatchFinished || !proposed.length || t!.pages.length!==2} onClick={() => void perform(confirmProposals,"已确认完整配对，客观题进入计分，主观题进入已设置的教师队列")}>确认上述 {proposed.length} 份配对</Button></div>
          <div className="flex flex-wrap items-center gap-3"><strong>人工配页 / 补页</strong><label>考号 <input className={field} value={student} onChange={e => setStudent(e.target.value)} inputMode="numeric" placeholder={`保留 ${t!.identity.digits} 位`} /></label><label>补入已有答卷 <select className={field} value={supplement} onChange={e=>{setSupplement(e.target.value);const s=sheets.find(s=>s.id===e.target.value);if(s)setStudent(s.studentNumber);}}><option value="">新建答卷</option>{sheets.map(s=><option key={s.id} value={s.id}>{s.studentNumber}</option>)}</select></label><span>已选扫描页：{selected.map(v=>batch.pages.find(p=>p.id===v)?.index).join("、") || "无"}</span><Button disabled={busy || !checkedOrder || !selected.length} onClick={() => void perform(confirmOne,"已确认页面归属")}>确认所选页面</Button></div>
        </section>}
        <div className="grid gap-5 xl:grid-cols-2">
          <section className={box}><h3 className="font-semibold">客观题标准答案</h3><p>空着表示未设置，不计为 0 分。五选二必须填两个字母；完全正确得满分，错选或多选得 0 分，漏选按下方设置。</p><div className="flex flex-wrap gap-3">{t!.questions.filter(q=>q.type==="objective").map(q=><label key={q.number}>第 {q.number} 题（{q.maxScore}分）<input className={`${field} ml-1 w-16`} aria-label={`第${q.number}题标准答案`} value={keys[q.number]??""} onChange={e=>setKeys({...keys,[q.number]:e.target.value})}/>{q.requiredSelections!>1 && <span> 漏选得 <input type="number" className={`${field} w-16`} value={partial[q.number]??0} min={0} max={q.maxScore} step={q.step} onChange={e=>setPartial({...partial,[q.number]:Number(e.target.value)})}/> 分</span>}</label>)}</div><Button disabled={busy} onClick={()=>void perform(saveAnswers,"标准答案已保存，仅重新计算客观题，主观题分数保留")}>确认答案及给分规则</Button></section>
          <section className={box}><h3 className="font-semibold">主观题阅卷分工</h3><p>同题选择多位教师表示共同分摊，每份只批一次。班级范围留空表示本次全部应考学生；正在批改的答卷不能直接改派。</p><table className="w-full text-left"><thead><tr><th>题目</th><th>教师（可多选）</th><th>班级范围（可留空）</th></tr></thead><tbody>{t!.questions.filter(q=>q.type==="subjective").map(q=><tr key={q.number}><td>第 {q.number} 题 · {q.maxScore} 分</td><td><select multiple className={`${field} min-w-36 max-h-24`} aria-label={`第${q.number}题教师`} value={(assignments[q.number]?.teacherIds??[]).map(String)} onChange={e=>setAssignments({...assignments,[q.number]:{classIds:assignments[q.number]?.classIds??[],teacherIds:Array.from(e.target.selectedOptions).map(o=>Number(o.value))}})}>{teachers.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></td><td><select multiple className={`${field} w-28 max-h-24`} aria-label={`第${q.number}题班级范围`} value={(assignments[q.number]?.classIds??[]).map(String)} onChange={e=>setAssignments({...assignments,[q.number]:{teacherIds:assignments[q.number]?.teacherIds??[],classIds:Array.from(e.target.selectedOptions).map(o=>Number(o.value))}})}>{overview.classes?.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></td></tr>)}</tbody></table><Button disabled={busy} onClick={()=>void perform(async()=>{await fetchJson(`${base}/assignments`,{method:"PUT",body:JSON.stringify(assignments)});},"分工已保存，教师可从阅卷入口开始批改；后续补扫沿用该分工")}>保存阅卷分工</Button></section>
        </div>
        <section className={box}><h3 className="font-semibold">答卷与客观题复核</h3><p>只处理不确定的填涂。未批、缺页、未设答案均保留未完成状态。点击题号可核对并纠正识别。</p><div className="overflow-auto"><table className="w-full text-left"><thead><tr><th>考号</th><th>客观题识别</th><th>正式总分</th></tr></thead><tbody>{sheets.map(s=><tr key={s.id}><td>{s.studentNumber}</td><td><div className="flex flex-wrap gap-2">{s.observations.map(o=><button className={`${field} ${o.status==="review"?"font-bold underline":""}`} key={o.questionNumber} onClick={()=>{setReview({sheet:s,question:o.questionNumber});setSelection(o.selectedOptions);}}>第{o.questionNumber}题 {o.selectedOptions.join("")||"空白"}{o.status==="review"?" · 待确认":""}</button>)}</div></td><td>{s.total==null?"未完成":s.total}</td></tr>)}</tbody></table></div><div className="flex gap-3"><Button variant="outline" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>上一批</Button><span>{offset+1}—{Math.min(offset+100,sheetCount)} / {sheetCount}</span><Button variant="outline" disabled={offset+100>=sheetCount} onClick={()=>setOffset(offset+100)}>下一批</Button></div></section>
        {review && <section className={box}><h3 className="font-semibold">考号 {review.sheet.studentNumber} · 第 {review.question} 题</h3>{review.sheet.pages.filter(p=>p.pageNumber===t!.questions.find(q=>q.number===review.question)!.options![0].page).map(p=><ExternalPaperImage key={p.id} url={`${base}/batches/${p.batchId}/pages/${p.index}/image`} alt="客观题核对原页" style={{maxWidth:1200}}/>)}<div className="flex flex-wrap gap-3">{t!.questions.find(q=>q.number===review.question)!.options!.map(o=><label key={o.label}><input type="checkbox" checked={selection.includes(o.label)} onChange={()=>setSelection(v=>v.includes(o.label)?v.filter(s=>s!==o.label):[...v,o.label])}/>{o.label}</label>)}<Button variant="outline" onClick={()=>setSelection([])}>确认为未作答</Button><Button disabled={busy} onClick={()=>void perform(async()=>{await fetchJson(`${base}/sheets/${review.sheet.id}/answers/${review.question}`,{method:"PUT",body:JSON.stringify({version:review.sheet.version,options:selection})});setReview(null);},"已按人工确认结果重新计分")}>保存确认</Button><Button variant="outline" onClick={()=>setReview(null)}>关闭</Button></div></section>}
      </>}
    </>}
  </div>;
}
