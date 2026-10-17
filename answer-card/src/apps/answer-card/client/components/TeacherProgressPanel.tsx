import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchJson } from "../auth/api";

type ProgressRow = {
  teacherId: number;
  teacherName: string;
  blockId: string;
  blockTitle: string | null;
  allocatedCount: number;
  assignedCount: number;
  scoredCount: number;
  claimedCount: number;
};

export function TeacherProgressPanel({ examId, active }: { examId: number; active: boolean }) {
  const [rows, setRows] = useState<ProgressRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchJson<{ ok: boolean; data: ProgressRow[] }>(
        `/api/review/exams/${examId}/teacher-progress`
      );
      setRows(result.data);
      setUpdatedAt(new Date());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载教师进度失败");
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const teachers = useMemo(() => {
    const totals = new Map<number, { id: number; name: string; assigned: number; scored: number; claimed: number }>();
    for (const row of rows) {
      const item = totals.get(row.teacherId) ?? {
        id: row.teacherId, name: row.teacherName, assigned: 0, scored: 0, claimed: 0,
      };
      item.assigned += row.assignedCount;
      item.scored += row.scoredCount;
      item.claimed += row.claimedCount;
      totals.set(row.teacherId, item);
    }
    return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [rows]);

  const questionNumber = (title: string | null) => Number(title?.match(/\d+/)?.[0] ?? 999);
  const details = [...rows].sort((a, b) =>
    a.teacherName.localeCompare(b.teacherName, "zh-CN") ||
    questionNumber(a.blockTitle) - questionNumber(b.blockTitle));

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">教师阅卷进度</h2>
          <p className="text-sm text-muted-foreground">
            按已分配试卷的实际完成情况统计，每 20 秒自动刷新。合并题组每份卷计一次，不重复统计历史小题。
            {updatedAt && ` 更新于 ${updatedAt.toLocaleTimeString()}`}
          </p>
        </div>
        <button type="button" className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm disabled:opacity-50"
          disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />刷新进度
        </button>
      </div>
      {error && <p className="rounded border border-destructive p-3 text-sm text-destructive-fg" role="alert">{error}</p>}
      {!error && !loading && rows.length === 0 && <p className="rounded border p-5 text-sm text-muted-foreground">本场考试还没有教师阅卷分配。</p>}
      {teachers.length > 0 && <>
        <div className="overflow-x-auto rounded border">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-muted/40 text-left"><tr>
              <th className="p-3">教师</th><th className="p-3 text-right">已分配题份</th>
              <th className="p-3 text-right">已批改</th><th className="p-3 text-right">待批改</th>
              <th className="p-3 text-right">当前领取</th><th className="p-3 text-right">完成率</th>
            </tr></thead>
            <tbody>{teachers.map(item => <tr key={item.id} className="border-t">
              <td className="p-3 font-medium">{item.name}</td>
              <td className="p-3 text-right tabular-nums">{item.assigned}</td>
              <td className="p-3 text-right tabular-nums">{item.scored}</td>
              <td className="p-3 text-right tabular-nums">{Math.max(0, item.assigned - item.scored)}</td>
              <td className="p-3 text-right tabular-nums">{item.claimed}</td>
              <td className="p-3 text-right tabular-nums">{item.assigned ? Math.round(item.scored / item.assigned * 100) : 0}%</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-2 font-medium">按题目查看</h3>
          <div className="max-h-[55vh] overflow-auto rounded border">
            <table className="w-full min-w-[650px] text-sm">
              <thead className="sticky top-0 bg-muted text-left"><tr>
                <th className="p-3">教师</th><th className="p-3">题目</th>
                <th className="p-3 text-right">已分配</th><th className="p-3 text-right">已批改</th>
                <th className="p-3 text-right">待批改</th><th className="p-3 text-right">完成率</th>
              </tr></thead>
              <tbody>{details.map((row, index) => <tr key={`${row.teacherId}-${row.blockId}-${index}`} className="border-t">
                <td className="p-3">{row.teacherName}</td>
                <td className="p-3">{row.blockTitle ?? row.blockId}</td>
                <td className="p-3 text-right tabular-nums">{row.assignedCount}</td>
                <td className="p-3 text-right tabular-nums">{row.scoredCount}</td>
                <td className="p-3 text-right tabular-nums">{Math.max(0, row.assignedCount - row.scoredCount)}</td>
                <td className="p-3 text-right tabular-nums">{row.assignedCount ? Math.round(row.scoredCount / row.assignedCount * 100) : 0}%</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
      </>}
    </section>
  );
}
