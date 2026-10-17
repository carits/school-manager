// BlockSelectPage —— 选择题块开始阅卷（T5 v2 迁移）
// 视觉层切换到 v2：Card / Progress / Badge / EmptyState / Spinner。
// 功能守恒：GET /api/review-assign/exams/:examId/teachers/me/blocks 与选块回调零改动。
import React, { useState, useEffect, useCallback } from "react";
import { ClipboardList } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { TeacherBlockAssignment } from "../../../../shared/types";
import { Badge, Card, EmptyState, Progress, Spinner } from "./ui/v2";

interface ReviewGroup { id: string; title: string; questionNumbers: number[]; mode: string; assignedCount: number; pendingCount: number; reviewedCount: number; heldCount: number }

interface Props {
  examId: number;
  teacherId: number;
  onSelectBlock: (blockId: string) => void;
}

export function BlockSelectPage({ examId, teacherId, onSelectBlock }: Props) {
  const [blocks, setBlocks] = useState<TeacherBlockAssignment[]>([]);
  const [groups, setGroups] = useState<ReviewGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupError, setGroupError] = useState("");

  const loadBlocks = useCallback(async () => {
    const [blockResult, groupResult] = await Promise.allSettled([
      fetchJson<{ ok: boolean; data: TeacherBlockAssignment[] }>(`/api/review-assign/exams/${examId}/teachers/me/blocks`),
      fetchJson<{ ok: boolean; groups: ReviewGroup[] }>(`/api/review-groups/exams/${examId}`),
    ]);
    if (blockResult.status === "fulfilled" && blockResult.value.ok) setBlocks(blockResult.value.data);
    if (groupResult.status === "fulfilled" && groupResult.value.ok && Array.isArray(groupResult.value.groups)) {
      const active = groupResult.value.groups.filter(g => g.mode === "active");
      setGroups(active);
      setGroupError(examId === 22 && active.length === 0 ? "合并阅卷题组暂不可用，请重试。" : "");
    } else {
      setGroupError(examId === 22 ? "合并阅卷题组读取失败，请重试。旧小题已停止评分。" : "");
    }
    setLoading(false);
  }, [examId]);

  useEffect(() => { void loadBlocks(); }, [loadBlocks]);
  useEffect(() => {
    if (!groupError) return;
    const timer = window.setTimeout(() => { void loadBlocks(); }, 15000);
    return () => window.clearTimeout(timer);
  }, [groupError, loadBlocks]);
  useEffect(() => {
    const reload = () => { if (document.visibilityState === "visible") void loadBlocks(); };
    document.addEventListener("visibilitychange", reload);
    return () => document.removeEventListener("visibilitychange", reload);
  }, [loadBlocks]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  if (blocks.length === 0 && groups.length === 0 && !groupError) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title="暂无可阅题块"
        description="尚未给你分配阅卷任务，请联系年级组长在「阅卷分配」中派发。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6" data-teacher-id={teacherId}>
      <h2 className="text-base font-medium text-foreground">选择题块阅卷或回看</h2>
      {groupError && <div role="alert" className="flex items-center gap-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><span>{groupError}</span><button type="button" onClick={() => void loadBlocks()} className="rounded border border-red-400 px-3 py-1">重新加载</button></div>}

      <div className="flex flex-col gap-3">
        {groups.map(group => <Card key={group.id} interactive className="p-4" role="button" tabIndex={0}
          onClick={() => onSelectBlock("review-group:" + group.id)}
          onKeyDown={e => { if(e.key==="Enter" || e.key===" "){e.preventDefault();onSelectBlock("review-group:" + group.id)} }}>
          <div className="mb-2 flex justify-between gap-3"><span className="font-medium">{group.title}（合并阅卷）</span><span>{group.reviewedCount}/{group.assignedCount}份</span></div>
          <Progress value={group.assignedCount ? Math.round(group.reviewedCount / group.assignedCount * 100) : 0} tone="primary" size="sm" />
          <p className="mt-2 text-sm text-muted-foreground">待评 {group.pendingCount} 份 · 已评可回看修改</p>
        </Card>)}
        {blocks.filter(block => {
          const q = /^第(\d+)题$/.exec(block.blockTitle || "");
          if (!q) return true;
          const number = Number(q[1]);
          // Exam 22 uses the merged entry for 46–60; the child score endpoint is frozen.
          if (examId === 22 && number >= 46 && number <= 60) return false;
          return !groups.some(group => group.questionNumbers.includes(number));
        }).map((block) => {
          const pct = block.totalCount > 0
            ? Math.round((block.remainingForMe / block.totalCount) * 100)
            : 100;
          const isDone = block.remainingForMe <= 0;

          return (
            <Card
              key={block.blockId}
              interactive
              className="p-4"
              onClick={() => onSelectBlock(block.blockId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectBlock(block.blockId);
                }
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="truncate text-base font-medium text-foreground">
                  {block.blockTitle || block.blockId}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {block.remainingForMe}/{block.totalCount}
                </span>
              </div>

              <Progress value={pct} tone={isDone ? "success" : "primary"} size="sm" />

              {isDone && (
                <div className="mt-2">
                  <Badge tone="success" dot>已完成，可回看修改</Badge>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
