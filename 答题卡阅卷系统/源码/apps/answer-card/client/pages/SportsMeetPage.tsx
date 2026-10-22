import { useEffect, useMemo, useState } from "react";
import { Download, Plus, RefreshCw, Save, Trophy } from "lucide-react";
import * as XLSX from "xlsx";
import { fetchJson } from "../auth/api";

type Meet = { id: number; name: string; start_date: string | null; end_date: string | null; status: string };
type Event = { id: number; meet_id: number; name: string; kind: string; result_kind: string; grade_name: string | null; gender: string | null; unit: string; stage: string; schedule_at: string | null };
type Participant = { id: number; name: string; class_name: string; grade_name: string | null; gender: string | null; participant_type: string };
type Heat = { id: number; event_id: number; event_name: string; stage: string; heat_no: number; scheduled_at: string | null };
type Entry = { id: number; event_id: number; participant_id: number; class_name: string; participant_name: string; event_name: string; result_text: string; result_value: number | null; status: string; rank_no: number | null; points: number };
type MeetData = { meet: Meet; events: Event[]; participants: Participant[]; heats: Heat[] };

const inputClass = "h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-primary";
const buttonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";
const secondaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-accent";
const CLASS_OPTIONS = Array.from({ length: 16 }, (_, index) => String(2601 + index));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetchJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response;
}

function downloadWorkbook(rows: Record<string, unknown>[], filename: string, sheetName = "成绩"): void {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

export function SportsMeetPage() {
  const [meets, setMeets] = useState<Meet[]>([]);
  const [selectedMeetId, setSelectedMeetId] = useState<number | null>(null);
  const [data, setData] = useState<MeetData | null>(null);
  const [results, setResults] = useState<{ rows: Entry[]; standings: Array<{ className: string; points: number }> }>({ rows: [], standings: [] });
  const [tab, setTab] = useState<"overview" | "setup" | "entry" | "results">("overview");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [newMeet, setNewMeet] = useState({ name: "" });
  const [newEvent, setNewEvent] = useState({ name: "", kind: "track", resultKind: "time", grade: "七年级", gender: "", stage: "决赛", scheduleAt: "" });
  const [newParticipant, setNewParticipant] = useState({ name: "", className: CLASS_OPTIONS[0], grade: "七年级", gender: "" });
  const [eventFilter, setEventFilter] = useState<number | null>(null);
  const [entryDrafts, setEntryDrafts] = useState<Record<number, { result: string; status: string }>>({});

  async function loadMeets(selectFirst = true) {
    const response = await fetchJson<{ ok: boolean; data: Meet[] }>("/api/sports-meets");
    const list = response.data ?? [];
    setMeets(list);
    if (selectFirst && list.length && selectedMeetId == null) setSelectedMeetId(list[0].id);
  }

  async function loadMeet(meetId: number) {
    const response = await fetchJson<{ ok: boolean; data: MeetData }>(`/api/sports-meets/${meetId}`);
    setData(response.data);
    if (response.data.events.length && eventFilter == null) setEventFilter(response.data.events[0].id);
    const resultResponse = await fetchJson<{ ok: boolean; data: { rows: Entry[]; standings: Array<{ className: string; points: number }> } }>(`/api/sports-meets/${meetId}/results`);
    setResults(resultResponse.data ?? { rows: [], standings: [] });
  }

  useEffect(() => { void loadMeets(); }, []);
  useEffect(() => { if (selectedMeetId != null) void loadMeet(selectedMeetId); }, [selectedMeetId]);

  const entriesForEvent = useMemo(() => results.rows.filter((row) => row.event_id === eventFilter), [results.rows, eventFilter]);

  async function createMeet() {
    if (!newMeet.name.trim()) return;
    setBusy(true);
    try {
      const response = await postJson<{ data: Meet }>("/api/sports-meets", newMeet);
      setNewMeet({ name: "" });
      await loadMeets(false);
      setSelectedMeetId(response.data.id);
      setMessage("赛事已创建");
    } finally { setBusy(false); }
  }

  async function createEvent() {
    if (!selectedMeetId || !newEvent.name.trim()) return;
    setBusy(true);
    try {
      await postJson(`/api/sports-meets/${selectedMeetId}/events`, newEvent);
      await loadMeet(selectedMeetId);
      setNewEvent({ ...newEvent, name: "" });
      setMessage("项目已添加");
    } finally { setBusy(false); }
  }

  async function createParticipant() {
    if (!selectedMeetId || !newParticipant.name.trim() || !newParticipant.className.trim()) return;
    setBusy(true);
    try {
      await postJson(`/api/sports-meets/${selectedMeetId}/participants`, newParticipant);
      await loadMeet(selectedMeetId);
      setNewParticipant({ ...newParticipant, name: "" });
      setMessage("运动员已添加");
    } finally { setBusy(false); }
  }

  async function saveEntry(entry: Entry) {
    if (!selectedMeetId) return;
    const draft = entryDrafts[entry.id] ?? { result: entry.result_text, status: entry.status };
    setBusy(true);
    try {
      await postJson(`/api/sports-meets/${selectedMeetId}/entries`, { eventId: entry.event_id, participantId: entry.participant_id, result: draft.result, status: draft.status });
      await loadMeet(selectedMeetId);
      setMessage("成绩已保存，名次和积分已更新");
    } finally { setBusy(false); }
  }

  async function seedEntries(eventId: number) {
    if (!selectedMeetId) return;
    setBusy(true);
    try {
      await postJson(`/api/sports-meets/${selectedMeetId}/events/${eventId}/seed-entries`, {});
      await loadMeet(selectedMeetId);
      setMessage("已按项目条件生成参赛名单");
    } finally { setBusy(false); }
  }

  async function exportResults() {
    if (!selectedMeetId) return;
    const response = await fetchJson<{ data: Record<string, unknown>[] }>(`/api/sports-meets/${selectedMeetId}/export`);
    downloadWorkbook(response.data ?? [], `${data?.meet.name ?? "运动会"}-成绩.xlsx`);
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ name: "七年级男子100米", kind: "track", resultKind: "time", grade: "七年级", gender: "男子", stage: "决赛", scheduleAt: "2026-10-15 08:30" }]), "项目赛程");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ name: "张三", className: "2601", grade: "七年级", gender: "男子", type: "individual" }]), "运动员");
    XLSX.writeFile(workbook, "运动会导入模板.xlsx");
  }

  async function importFile(file: File) {
    if (!selectedMeetId) return;
    let rows: Array<Record<string, unknown>> = [];
    if (/\.xlsx?$/i.test(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet]!, { defval: "" });
    } else {
      const content = await file.text();
      const lines = content.replace(/^\ufeff/, "").split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return;
      const headers = lines[0].split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
      rows = lines.slice(1).map((line) => {
        const values = line.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
      });
    }
    if (!rows.length) return;
    const sheet = rows[0]?.sheet === "participants" || "姓名" in rows[0] || "队名" in rows[0] || "className" in rows[0] ? "participants" : "events";
    const response = await postJson<{ data: { imported: number; errors: Array<{ row: number; error: string }> } }>(`/api/sports-meets/${selectedMeetId}/import`, { sheet, rows });
    await loadMeet(selectedMeetId);
    setMessage(`已导入 ${response.data.imported} 行${response.data.errors.length ? `，${response.data.errors.length} 行失败` : ""}`);
  }

  return (
    <div className="min-h-full space-y-5 p-5 lg:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><Trophy className="text-primary" size={24} /><h1 className="text-2xl font-semibold">运动会成绩管理</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">录入时间或成绩后，系统自动计算名次、个人积分和班级团体总分。</p><p className="mt-1 text-xs text-muted-foreground">参赛班级：2601—2616</p>
        </div>
        <div className="flex items-center gap-2">
          <select className={`${inputClass} min-w-48`} value={selectedMeetId ?? ""} onChange={(event) => setSelectedMeetId(Number(event.target.value) || null)}>
            <option value="">选择赛事</option>{meets.map((meet) => <option key={meet.id} value={meet.id}>{meet.name}</option>)}
          </select>
          <button className={secondaryButtonClass} onClick={() => void loadMeets()}><RefreshCw size={16} />刷新</button>
        </div>
      </div>

      {message && <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">{message}</div>}
      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {([["overview", "赛事首页"], ["setup", "赛事配置"], ["entry", "成绩录入"], ["results", "成绩查询"]] as const).map(([key, label]) => <button key={key} className={`rounded-lg px-4 py-2 text-sm ${tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`} onClick={() => setTab(key)}>{label}</button>)}
      </div>

      {!meets.length && <section className="rounded-xl border border-dashed border-border bg-card p-6"><h2 className="text-lg font-medium">创建第一场运动会</h2><div className="mt-4 grid gap-3 md:grid-cols-2"><input className={inputClass} placeholder="赛事名称，例如 中雅实验学校2026秋季运动会" value={newMeet.name} onChange={(e) => setNewMeet({ ...newMeet, name: e.target.value })} /></div><button className={`${buttonClass} mt-4`} disabled={busy || !newMeet.name.trim()} onClick={() => void createMeet()}><Plus size={16} />创建赛事</button></section>}

      {data && tab === "overview" && <div className="grid gap-4 md:grid-cols-3"><Metric label="项目数" value={data.events.length} /><Metric label="运动员/队伍" value={data.participants.length} /><Metric label="已录成绩" value={results.rows.filter((row) => row.result_text).length} /><section className="md:col-span-2 rounded-xl border border-border bg-card p-5"><h2 className="font-medium">班级团体积分</h2><div className="mt-4 space-y-2">{results.standings.length ? results.standings.map((row, index) => <div className="flex items-center justify-between rounded-lg bg-accent/40 px-3 py-2" key={row.className}><span>{index + 1}. {row.className}</span><strong>{row.points} 分</strong></div>) : <p className="text-sm text-muted-foreground">录入成绩后显示团体积分。</p>}</div></section><section className="rounded-xl border border-border bg-card p-5"><h2 className="font-medium">赛程概览</h2><div className="mt-4 space-y-2 text-sm">{data.events.slice(0, 8).map((event) => <div className="flex justify-between gap-2" key={event.id}><span>{event.name}</span><span className="text-muted-foreground">{event.schedule_at || "未排时间"}</span></div>)}</div></section></div>}

      {data && tab === "setup" && <div className="grid gap-5 lg:grid-cols-2"><section className="rounded-xl border border-border bg-card p-5"><div className="flex items-center justify-between"><h2 className="font-medium">添加比赛项目</h2><div className="flex gap-2"><button className={secondaryButtonClass} onClick={downloadTemplate}>下载导入模板</button><label className={secondaryButtonClass}>导入 Excel/CSV<input className="hidden" type="file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.currentTarget.value = ""; }} /></label></div></div><div className="mt-4 grid gap-3"><input className={inputClass} placeholder="项目名称，如 七年级男子100米" value={newEvent.name} onChange={(e) => setNewEvent({ ...newEvent, name: e.target.value })} /><div className="grid gap-3 sm:grid-cols-2"><select className={inputClass} value={newEvent.kind} onChange={(e) => setNewEvent({ ...newEvent, kind: e.target.value, resultKind: e.target.value === "field" ? "distance" : "time" })}><option value="track">径赛</option><option value="field">田赛</option><option value="relay">接力</option></select><select className={inputClass} value={newEvent.resultKind} onChange={(e) => setNewEvent({ ...newEvent, resultKind: e.target.value })}><option value="time">时间（越小越好）</option><option value="distance">距离（越大越好）</option><option value="height">高度（越大越好）</option></select></div><div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} placeholder="年级" value={newEvent.grade} onChange={(e) => setNewEvent({ ...newEvent, grade: e.target.value })} /><input className={inputClass} placeholder="性别（可选）" value={newEvent.gender} onChange={(e) => setNewEvent({ ...newEvent, gender: e.target.value })} /></div><div className="grid gap-3 sm:grid-cols-2"><select className={inputClass} value={newEvent.stage} onChange={(e) => setNewEvent({ ...newEvent, stage: e.target.value })}><option>预赛</option><option>半决赛</option><option>决赛</option></select><input className={inputClass} type="time" value={newEvent.scheduleAt} onChange={(e) => setNewEvent({ ...newEvent, scheduleAt: e.target.value })} /></div><button className={buttonClass} disabled={busy || !newEvent.name.trim()} onClick={() => void createEvent()}><Plus size={16} />添加项目</button></div><div className="mt-6 space-y-2">{data.events.map((event) => <div className="rounded-lg border border-border px-3 py-2 text-sm" key={event.id}><div className="flex justify-between"><strong>{event.name}</strong><span>{event.stage}</span></div><div className="mt-1 text-xs text-muted-foreground">{event.kind} · {event.result_kind} · {event.schedule_at || "未排时间"}</div></div>)}</div></section><section className="rounded-xl border border-border bg-card p-5"><h2 className="font-medium">添加运动员或接力队</h2><div className="mt-4 grid gap-3"><input className={inputClass} placeholder="姓名或队名" value={newParticipant.name} onChange={(e) => setNewParticipant({ ...newParticipant, name: e.target.value })} /><div className="grid gap-3 sm:grid-cols-2"><select className={inputClass} value={newParticipant.className} onChange={(e) => setNewParticipant({ ...newParticipant, className: e.target.value })}>{CLASS_OPTIONS.map((className) => <option key={className} value={className}>{className}</option>)}</select><input className={inputClass} placeholder="年级" value={newParticipant.grade} onChange={(e) => setNewParticipant({ ...newParticipant, grade: e.target.value })} /></div><select className={inputClass} value={newParticipant.gender} onChange={(e) => setNewParticipant({ ...newParticipant, gender: e.target.value })}><option value="">性别（可选）</option><option>男子</option><option>女子</option></select><button className={buttonClass} disabled={busy || !newParticipant.name.trim() || !newParticipant.className.trim()} onClick={() => void createParticipant()}><Plus size={16} />添加运动员</button></div><div className="mt-6 max-h-80 space-y-2 overflow-auto">{data.participants.map((participant) => <div className="flex justify-between rounded-lg border border-border px-3 py-2 text-sm" key={participant.id}><span>{participant.name}</span><span className="text-muted-foreground">{participant.class_name}</span></div>)}</div></section></div>}

      {data && tab === "entry" && <section className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">成绩录入</h2><div className="flex gap-2"><select className={inputClass} value={eventFilter ?? ""} onChange={(e) => setEventFilter(Number(e.target.value) || null)}><option value="">选择项目</option>{data.events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select>{eventFilter && <button className={secondaryButtonClass} disabled={busy} onClick={() => void seedEntries(eventFilter)}>生成参赛名单</button>}</div></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="px-3 py-3">姓名/队名</th><th>班级</th><th>成绩</th><th>状态</th><th>名次</th><th>积分</th><th /></tr></thead><tbody>{entriesForEvent.length ? entriesForEvent.map((entry) => { const draft = entryDrafts[entry.id] ?? { result: entry.result_text, status: entry.status }; return <tr className="border-b border-border/70" key={entry.id}><td className="px-3 py-3 font-medium">{entry.participant_name}</td><td>{entry.class_name}</td><td><input className={`${inputClass} w-32`} value={draft.result} onChange={(e) => setEntryDrafts({ ...entryDrafts, [entry.id]: { ...draft, result: e.target.value } })} placeholder="如 12.34" /></td><td><select className={`${inputClass} w-28`} value={draft.status} onChange={(e) => setEntryDrafts({ ...entryDrafts, [entry.id]: { ...draft, status: e.target.value } })}><option value="valid">有效</option><option value="dns">弃权</option><option value="dnf">未完成</option><option value="foul">犯规</option></select></td><td>{entry.rank_no ?? "—"}</td><td>{entry.points || "—"}</td><td><button className={secondaryButtonClass} onClick={() => void saveEntry(entry)} disabled={busy}><Save size={15} />保存</button></td></tr>; }) : <tr><td className="px-3 py-8 text-center text-muted-foreground" colSpan={7}>请先点击“生成参赛名单”，然后录入成绩。</td></tr>}</tbody></table></div></section>}

      {data && tab === "results" && <section className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">成绩查询</h2><button className={secondaryButtonClass} onClick={() => void exportResults()}><Download size={16} />导出 Excel</button></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="px-3 py-3">项目</th><th>阶段</th><th>姓名/队名</th><th>班级</th><th>成绩</th><th>名次</th><th>积分</th></tr></thead><tbody>{results.rows.length ? results.rows.map((row) => <tr className="border-b border-border/70" key={row.id}><td className="px-3 py-3">{row.event_name}</td><td>—</td><td className="font-medium">{row.participant_name}</td><td>{row.class_name}</td><td>{row.result_text || "—"}</td><td>{row.rank_no ?? "—"}</td><td>{row.points || "—"}</td></tr>) : <tr><td className="px-3 py-8 text-center text-muted-foreground" colSpan={7}>暂无成绩。</td></tr>}</tbody></table></div></section>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <section className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></section>;
}
