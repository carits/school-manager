import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, ZoomIn, ZoomOut, RotateCw, RotateCcw, PenLine, Save } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { ScorePad } from "./ScorePad";
import { AnnotationOverlay } from "./AnnotationOverlay";
import type { ReviewBlockCropItem, ReviewAnnotation, ReviewSubmitResult } from "../../../../shared/types";
import { Button, EmptyState, Kbd } from "./ui/v2";
import { cn } from "../lib/utils";
import { retryMediaTicketImage } from "../lib/mediaTicketRetry";

interface Props {
  examId: number;
  blockId: string;
  teacherId: number;
  onBack: () => void;
}

interface AiSuggestion {
  id: string;
  status: "completed";
  questionNumber: number;
  score: number;
  maxScore: number;
  answerText: string;
  reason: string;
  rubricVersion: string;
}

export function GradePanel({ examId, blockId, teacherId, onBack }: Props) {
  const [queue, setQueue] = useState<ReviewBlockCropItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  // v1.9.0: 自动检测设备类型：触摸设备(PAD/手机)默认手写，桌面端默认文字批注
  const [annotateMode, setAnnotateMode] = useState<"text" | "drawing" | false>(false);
  const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  const [draftScores, setDraftScores] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [poolReady, setPoolReady] = useState(false);
  const autoClaimStarted = useRef(false);
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"success" | "error">("error");
  const [scoringMode, setScoringMode] = useState<string>("block_total");
  const imageRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef(queue); queueRef.current = queue;
  const submitLock = useRef(false);
  const claimLock = useRef(false);
  const alive = useRef(true);
  const annotationRequest = useRef(0);
  const currentCropId = useRef<string | undefined>(undefined);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionWrite = useRef<(() => void) | null>(null);
  const decoded = useRef(new Map<string, HTMLImageElement>());
  const prefetchedUrls = useRef(new Map<string, string>());
  const lookahead = useRef<{ cropId: string; result: Promise<ReviewBlockCropItem | null> } | null>(null);
  const [imageReadyId, setImageReadyId] = useState<string | null>(null);
  const [imageFailedId, setImageFailedId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(0);
  const [submittedIds, setSubmittedIds] = useState<Set<string>>(() => new Set());
  const [reference, setReference] = useState<{questions: Array<{questionNumber:number;answerText:string|null}>;
    answerPages: Array<{pageIndex:number;filename:string;isImage:boolean}>} | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referenceFile, setReferenceFile] = useState<number | null>(null);
  const [aiSuggestionState, setAiSuggestionState] = useState<{cropId: string; data: AiSuggestion} | null>(null);
  const [adoptingAi, setAdoptingAi] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [assignedQuota, setAssignedQuota] = useState<number | null>(null);
  const [queueView, setQueueView] = useState<"pending" | "reviewed">("pending");
  const aiRequest = useRef(0);
  const poolUrl = `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(blockId)}`;
  const prefetchImage = useCallback(async (item: ReviewBlockCropItem) => {
    if (decoded.current.has(item.id)) return;
    const url = prefetchedUrls.current.get(item.id) ?? mediaUrl(item.imageUrl);
    prefetchedUrls.current.set(item.id, url);
    const img = new Image(); img.src = url;
    try {
      await img.decode();
      if (!alive.current) return;
      decoded.current.set(item.id, img);
      while (decoded.current.size > 4) decoded.current.delete(decoded.current.keys().next().value!);
      while (prefetchedUrls.current.size > 8) prefetchedUrls.current.delete(prefetchedUrls.current.keys().next().value!);
      // Keep the browser's decoded image alive, but do not reserve a student's paper.

    } catch { /* actual image has a visible retry path */ }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; annotationRequest.current++; decoded.current.clear(); prefetchedUrls.current.clear();
      if (sessionTimer.current) { clearTimeout(sessionTimer.current); sessionWrite.current?.(); }
    };
  }, []);

  const current = queue[currentIndex];
  currentCropId.current = current?.id;
  const currentScore = current ? (draftScores[current.id] ?? current.score ?? null) : null;
  const currentAiSuggestion = current && aiSuggestionState?.cropId === current.id ? aiSuggestionState.data : null;
  const maxScore = current?.maxScore ?? 0;
  const [mobileReferenceExpanded, setMobileReferenceExpanded] = useState(false);
  const showMobileReference = maxScore < 10 || mobileReferenceExpanded;
  const imageReady = Boolean(current && imageFailedId !== current.id && (imageReadyId === current.id || decoded.current.has(current.id)));
  useEffect(() => {
    if (!current) return;
    const cropId = current.id;
    const img = imageRef.current?.querySelector<HTMLImageElement>('img[data-testid="student-answer"]');
    if (!img) return;
    const markReady = () => {
      if (alive.current && currentCropId.current === cropId && img.naturalWidth > 0) {
        setImageReadyId(cropId);
        setImageFailedId(null);
      }
    };
    // Cached images can finish before React's onLoad handler is attached.
    if (img.complete) markReady();
    img.addEventListener("load", markReady);
    return () => img.removeEventListener("load", markReady);
  }, [current?.id]);
  const isCurrentSubmitted = Boolean(current && submittedIds.has(current.id));
  const pendingCount = queue.filter((item) => !submittedIds.has(item.id)).length;
  const resetView = useCallback(() => {
    setZoom(1); setRotation(0); setAnnotateMode(false); setAnnotations([]);
    setImageFailedId(null); if (imageRef.current) imageRef.current.scrollTo(0, 0);
  }, []);
  // 是否已为本卷显式选过分数（防止未选分时误提交 0 分）
  const hasEnteredScore = current ? draftScores[current.id] !== undefined : false;

  // Queue and session are initialized together so a late session never changes the next paper.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const results = await Promise.allSettled([
        fetchJson<{ok:boolean;data:{entries:ReviewBlockCropItem[];summary?:{assignments?:Array<{teacherId:number;assignedCount:number}>}}}>(poolUrl + "?mine=1"),
        fetchJson<{ok:boolean;data?:{draftScores?:Record<string,number>;positionJson?:{cropId?:string}}}>(
          `/api/review-session/exams/${examId}/blocks/${encodeURIComponent(blockId)}`),
        fetchJson<{ok:boolean;data:ReviewBlockCropItem[]}>(poolUrl + "/my-reviewed")
      ]);
      if (cancelled) return;
      const pool = results[0], session = results[1], reviewed = results[2];
      if (pool.status === "fulfilled" && pool.value.ok) {
        const reviewedEntries = reviewed.status === "fulfilled" && reviewed.value.ok ? reviewed.value.data : [];
        const entries = [...reviewedEntries.filter(item => !pool.value.data.entries.some(held => held.id === item.id)), ...pool.value.data.entries];
        const alreadySubmitted = new Set(reviewedEntries.map(item => item.id));
        queueRef.current = entries;
        setQueue(entries);
        setSubmittedIds(alreadySubmitted);
        setReviewedCount(reviewedEntries.length);
        const myAssignment = pool.value.data.summary?.assignments?.find(item => Number(item.teacherId) === teacherId);
        setAssignedQuota(myAssignment ? Number(myAssignment.assignedCount) : null);
        const restoredCropId = session.status === "fulfilled" ? session.value.data?.positionJson?.cropId : undefined;
        const restoredIndex = restoredCropId ? entries.findIndex(item => item.id === restoredCropId) : -1;
        const firstPending = entries.findIndex(item => !alreadySubmitted.has(item.id));
        if (firstPending >= 0) setCurrentIndex(restoredIndex >= 0 && !alreadySubmitted.has(entries[restoredIndex].id) ? restoredIndex : firstPending);
        else if (entries.length) { setQueueView("reviewed"); setCurrentIndex(restoredIndex >= 0 ? restoredIndex : entries.length - 1); }
        setPoolReady(true);
        if (session.status === "fulfilled" && session.value.data?.draftScores) {
          const ids = new Set(entries.map(x => x.id));
          setDraftScores(Object.fromEntries(Object.entries(session.value.data.draftScores).filter(([id]) => ids.has(id))));
        }
      } else setError(pool.status === "rejected" ? String(pool.reason?.message ?? pool.reason) : "读取已领试卷失败");
      setSessionLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [poolUrl, examId, blockId, teacherId]);

  const claimNext = useCallback(async (preferred?: ReviewBlockCropItem | null, afterSerial?: number | null) => {
    if (claimLock.current) return;
    claimLock.current = true; setClaiming(true);
    try {
      let res: {ok:boolean;data?:ReviewBlockCropItem;error?:string};
      if (preferred) {
        try {
          res = await fetchJson(poolUrl + "/crops/" + encodeURIComponent(preferred.id) + "/claim",
            {method:"POST",body:"{}"});
        } catch (err: any) {
          if (err.status !== 409) throw err;
          res = await fetchJson(poolUrl + "/claim", {method:"POST",body:JSON.stringify({afterSerial})});
        }
      } else res = await fetchJson(poolUrl + "/claim", {method:"POST",body:JSON.stringify({afterSerial})});
      if (!res.ok || !res.data) throw new Error(res.error ?? "领卷失败");
      if (!alive.current) return;
      const item = res.data;
      const next = [...queueRef.current.filter(x => x.id !== item.id), item];
      queueRef.current = next; setQueue(next); setCurrentIndex(next.length - 1);
      resetView(); void prefetchImage(item);
      return true;
    } catch (err: any) {
      if (alive.current) { setError(err.message); setErrorTone("error"); }
    } finally {
      claimLock.current = false;
      if (alive.current) setClaiming(false);
    }
  }, [poolUrl, resetView, prefetchImage]);
  const continueToNext = useCallback(async (knownSubmitted = submittedIds) => {
    const items = queueRef.current;
    if (queueView === "reviewed" && current && knownSubmitted.has(current.id)) {
      const nextReviewed = items.findIndex((item, index) => index > currentIndex && knownSubmitted.has(item.id));
      if (nextReviewed >= 0) {
        setCurrentIndex(nextReviewed);
        resetView();
        return true;
      }
    }
    if (assignedQuota !== null && assignedQuota > 0 && knownSubmitted.size >= assignedQuota) {
      setQueueView("reviewed");
      setError("本题分配的试卷已全部评完，可用上一张回看和修改分数");
      setErrorTone("success");
      return false;
    }
    const pending = items.map((item, index) => ({item, index})).filter(({item}) => !knownSubmitted.has(item.id));
    const anchor = current?.serialNumber;
    pending.sort((a, b) => {
      const aSerial = a.item.serialNumber ?? Number.MAX_SAFE_INTEGER;
      const bSerial = b.item.serialNumber ?? Number.MAX_SAFE_INTEGER;
      return aSerial - bSerial || a.index - b.index;
    });
    const nextIndex = pending.find(({item}) => anchor != null && (item.serialNumber ?? 0) > anchor)?.index
      ?? pending[0]?.index ?? -1;
    if (nextIndex >= 0) {
      setQueueView("pending");
      setCurrentIndex(nextIndex);
      resetView();
      return true;
    }
    const preview = lookahead.current?.cropId === current?.id ? await lookahead.current.result : null;
    const claimed = await claimNext(preview, current?.serialNumber);
    if (claimed) setQueueView("pending");
    return Boolean(claimed);
  }, [currentIndex, current?.id, current?.serialNumber, submittedIds, queueView, assignedQuota, claimNext, resetView]);


  // A teacher's assigned papers open immediately; claiming is an internal lock, not a UI step.
  useEffect(() => {
    if (!sessionLoaded || !poolReady || autoClaimStarted.current) return;
    // Run the initial claim decision only once. After a score is saved,
    // continueToNext owns navigation; a second effect claim can race it and
    // reopen the first available paper.
    autoClaimStarted.current = true;
    if (queueRef.current.some(item=>!submittedIds.has(item.id))) return;
    if (assignedQuota !== null && assignedQuota > 0 && reviewedCount >= assignedQuota) return;
    const reviewed = queueRef.current.filter(item=>submittedIds.has(item.id));
    const afterSerial = reviewed[reviewed.length-1]?.serialNumber;
    void (async()=>{
      let preferred: ReviewBlockCropItem | null = null;
      if (afterSerial) {
        try {
          const response = await fetchJson<{ok:boolean;data:ReviewBlockCropItem|null}>(
            poolUrl + "/next-preview?afterSerial=" + afterSerial);
          preferred = response.data ?? null;
        } catch { /* generic claim still works */ }
      }
      const claimed = await claimNext(preferred, afterSerial);
      if (claimed) setQueueView("pending");
    })();
  }, [sessionLoaded, poolReady, queue.length, submittedIds, assignedQuota, reviewedCount, claimNext, poolUrl]);

  // Session persistence is outside the scoring critical path and coalesces rapid changes.
  const saveSession = useCallback((idx: number, scores: Record<string, number>) => {
    if (sessionTimer.current) clearTimeout(sessionTimer.current);
    sessionWrite.current = () => {
      sessionTimer.current = null;
      void fetchJson(`/api/review-session/exams/${examId}/blocks/${encodeURIComponent(blockId)}`, {
        method:"PUT", body:JSON.stringify({currentIndex:idx,positionJson:{zoom,rotation,cropId:queueRef.current[idx]?.id},draftScores:scores})
      }).catch(() => {});
    };
    sessionTimer.current = setTimeout(() => sessionWrite.current?.(), 300);
  }, [examId, blockId, zoom, rotation]);

  // 加载题块评分配置
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data?: { scoringMode?: string } }>(
        `/api/block-grading-config/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
      );
      if (alive.current && res.ok && res.data?.scoringMode) setScoringMode(res.data.scoringMode);
    } catch { /* 使用默认题块总分模式 */ }
  }, [examId, blockId]);

  const loadAnnotations = useCallback(async (cropId: string) => {
    const request = ++annotationRequest.current;
    try {
      const res = await fetchJson<{ok:boolean;data:ReviewAnnotation[]}>(`/api/review-annotations?cropId=${encodeURIComponent(cropId)}`);
      if (alive.current && request === annotationRequest.current) setAnnotations(res.ok ? res.data : []);
    } catch { if (alive.current && request === annotationRequest.current) setAnnotations([]); }
  }, []);
  const loadReference = useCallback(async () => {
    setReferenceError(null);
    try {
      const res = await fetchJson<{ok:boolean;data:NonNullable<typeof reference>}>(
        `/api/review/exams/${examId}/blocks/${encodeURIComponent(blockId)}/reference`);
      if (alive.current && res.ok) setReference(res.data);
    } catch (err: any) { if (alive.current) setReferenceError(err.message); }
  }, [examId, blockId]);
  useEffect(() => { void loadConfig(); void loadReference(); }, [loadConfig, loadReference]);
  useEffect(() => {
    setAnnotations([]); annotationRequest.current++;
    if (current) void loadAnnotations(current.id);
    const remaining = queue.slice(currentIndex + 1, currentIndex + 3);
    remaining.forEach(item => void prefetchImage(item));
    if (current && remaining.length === 0) {
      const request = fetchJson<{ok:boolean;data:ReviewBlockCropItem|null}>(poolUrl + "/next-preview" +
        (current.serialNumber ? "?afterSerial=" + current.serialNumber : ""))
        .then(res => {
          if (res.data && alive.current) void prefetchImage(res.data);
          return res.data;
        }).catch(() => null);
      lookahead.current = {cropId: current.id, result: request};
    } else lookahead.current = null;
  }, [current?.id, loadAnnotations, poolUrl, prefetchImage]);
  useEffect(() => {
    const request = ++aiRequest.current;
    const cropId = current?.id;
    setAiSuggestionState(null);
    if (!cropId) return;
    void fetchJson<{ok: boolean; data: AiSuggestion | null}>(
      `/api/review/exams/${examId}/block-crops/${encodeURIComponent(cropId)}/ai-suggestion`
    ).then((res) => {
      if (alive.current && request === aiRequest.current && res.ok && res.data?.status === "completed") {
        setAiSuggestionState({cropId, data: res.data});
      }
    }).catch(() => { /* No completed suggestion: keep the grading UI unchanged. */ });
    return () => { aiRequest.current++; };
  }, [examId, current?.id]);
  useEffect(() => {
    if (sessionLoaded) saveSession(currentIndex, draftScores);
  }, [currentIndex, draftScores, sessionLoaded, saveSession]);

  // 导航
  const goTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(queue.length - 1, index));
    if (submitLock.current || claimLock.current) return;
    if (queue[clamped]) setQueueView(submittedIds.has(queue[clamped].id) ? "reviewed" : "pending");
    setCurrentIndex(clamped);
    setError(null);
    resetView();
  }, [queue, submittedIds, resetView]);

  // 分数变化
  const handleScoreChange = useCallback((score: number) => {
    if (!current) return;
    const newScores = { ...draftScores, [current.id]: score };
    setDraftScores(newScores);
  }, [current, draftScores]);

  const adoptAiSuggestion = useCallback(async () => {
    if (!current || !currentAiSuggestion || adoptingAi || saving || claiming) return;
    const cropId = current.id;
    const suggestion = currentAiSuggestion;
    setAdoptingAi(true);
    setError(null);
    try {
      const response = await fetchJson<{ok: boolean; data?: {suggestion: AiSuggestion; formalScoreWritten: boolean}}>(
        `/api/review/exams/${examId}/block-crops/${encodeURIComponent(cropId)}/ai-suggestion/adopt`,
        {method: "POST", body: JSON.stringify({suggestionId: suggestion.id})}
      );
      if (!response.ok || response.data?.formalScoreWritten !== false || response.data.suggestion.id !== suggestion.id) {
        throw new Error("采用AI建议失败，请刷新后重试");
      }
      if (alive.current && currentCropId.current === cropId) {
        setDraftScores((scores) => ({...scores, [cropId]: suggestion.score}));
        setError("AI建议分数已填入草稿，请核对后点击保存并下一份");
        setErrorTone("success");
      }
    } catch (err: any) {
      if (alive.current && currentCropId.current === cropId) {
        setError(err.message || "采用AI建议失败");
        setErrorTone("error");
      }
    } finally {
      if (alive.current) setAdoptingAi(false);
    }
  }, [current, currentAiSuggestion, adoptingAi, saving, claiming, examId]);

  // 保存并下一份
  const handleSubmit = useCallback(async (scoreOverride?: number) => {
    if (!current || submitLock.current || claimLock.current || !imageReady) return;
    if (scoreOverride === undefined && draftScores[current.id] === undefined) {
      setError("请先选择分数再提交，避免误提交 0 分");
      setErrorTone("error");
      return;
    }
    if (scoringMode === "per_question") {
      setError("本题块为逐题评分模式，请使用在线阅卷逐题输入");
      return;
    }
    submitLock.current = true; setSaving(true);
    setError(null); setErrorTone("error");
    const savingCropId = current.id;
    let scoreCommitted = false;

    try {
      const score = scoreOverride ?? draftScores[current.id] ?? 0;
      if (!Number.isFinite(score) || score < 0 || score > maxScore) throw new Error("分数超出本题满分范围");
      // The next crop is previewed and prefetched, but a new claim must wait
      // until this score is committed and the current claim is released.
      const nextSubmitted = new Set(submittedIds);
      nextSubmitted.add(current.id);
      const res = await fetchJson<ReviewSubmitResult>(
        `/api/review/exams/${examId}/block-crops/${encodeURIComponent(current.id)}/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            scores: current.questionNumbers.map((q: any) => ({
              questionNumber: Number(q),
              scoreType: current.blockType || "subjective",
            })),
            blockTotalScore: score,
            status: "reviewed",
            // Legacy PDF marks use reviewRound as their score version. Send it
            // for both first scores and edits so stale tabs cannot overwrite edits.
            ...(current.sourceType === "legacy_pdf" ? { version: current.reviewRound ?? 0 } : {}),
          }),
        }
      );

      if (!res.ok) throw new Error((res as any).error ?? "保存失败");
      scoreCommitted = true;
      if (!alive.current) throw new Error("阅卷界面已关闭");
      if (res.ok) {
        if (res.rankingsRecalculated === false) {
          setError(`分数已保存，但排名/赋分重算失败：${res.rankingError ?? "未知错误"}，请稍后联系管理员重算`);
          setErrorTone("error");
        } else if (res.assignedScoresRecalculated === false) {
          setError(`分数已保存，但赋分重算失败：${res.assignedScoreError ?? "未知错误"}，请稍后联系管理员重算`);
          setErrorTone("error");
        }
        if (res.disputed) {
          setError(`该卷已标记为争议：${res.disputeReason}`);
          setErrorTone("error");
        }

        setDraftScores(prev => { const next = {...prev}; delete next[current.id]; return next; });
        setSubmittedIds(nextSubmitted);
        if (!submittedIds.has(current.id)) { setCompleted(n => n + 1); setReviewedCount(n => n + 1); }
        const updated = queueRef.current.map((item) => item.id === current.id
          ? {
              ...item,
              status: res.status,
              score,
              reviewRound: res.reviewRound ?? item.reviewRound,
              claimedBy: null,
              claimedAt: null,
            }
          : item);
        queueRef.current = updated;
        setQueue(updated);
        const moved = await continueToNext(nextSubmitted);
        if (!moved && !(assignedQuota !== null && assignedQuota > 0 && nextSubmitted.size >= assignedQuota)) {
          setQueueView("reviewed");
          setError("分数已保存，下一份暂未打开。请点“下一张”重试。");
          setErrorTone("error");
        }
      }
    } catch (err: any) {
      const failedIndex = queueRef.current.findIndex(item => item.id === savingCropId);
      if (failedIndex >= 0) { setQueueView(scoreCommitted ? "reviewed" : "pending"); setCurrentIndex(failedIndex); }
      setError(scoreCommitted ? "分数已保存，下一份暂未打开。请点“下一张”重试。" : err.message);
      setErrorTone("error");
    }
    submitLock.current = false;
    if (alive.current) setSaving(false);
  }, [current, draftScores, examId, maxScore, scoringMode, imageReady, submittedIds, continueToNext, assignedQuota]);

  // 缩放
  const zoomIn = () => setZoom((z) => Math.min(4, z + 0.25));
  const zoomOut = () => setZoom((z) => Math.max(0.25, z - 0.25));

  // 旋转
  const rotateCW = () => setRotation((r) => (r + 90) % 360);
  const rotateCCW = () => setRotation((r) => (r - 90 + 360) % 360);

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, []);

  // 保存批注
  const handleSaveAnnotation = useCallback(async (ann: any) => {
    if (!current) return;
    try {
      await fetchJson(`/api/review-annotations`, {
        method: "POST",
        body: JSON.stringify({
          cropId: current.id,
          type: ann.type,
          dataJson: ann.dataJson,
          positionX: ann.x,
          positionY: ann.y,
          width: ann.w,
          height: ann.h,
        }),
      });
      if (alive.current && currentCropId.current === current.id) void loadAnnotations(current.id);
    } catch { /* silent */ }
  }, [current, loadAnnotations]);

  // 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest("input,textarea,select") || e.repeat || submitLock.current || claimLock.current) return;
      if (e.key === "Enter" && !saving && current) {
        e.preventDefault();
        if (isCurrentSubmitted && !hasEnteredScore) void continueToNext();
        else handleSubmit();
      }
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        goTo(currentIndex - 1);
      }
      if (e.key === "ArrowRight" && currentIndex < queue.length - 1) {
        goTo(currentIndex + 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentIndex, queue.length, saving, current, isCurrentSubmitted, hasEnteredScore, handleSubmit, continueToNext, goTo]);

  if (queue.length === 0) {
    return (
      <div className="p-6">
        <Button variant="outline" icon={<ArrowLeft />} disabled={saving || claiming} onClick={onBack}>返回</Button>
        <EmptyState
          className="mt-6"
          icon={<ClipboardList />}
          title={error || (saving ? "分数已保存，正在切换下一份" : !sessionLoaded || claiming ? "正在打开下一份试卷…" : "当前没有待阅试卷")}
        />
        {error && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" disabled={claiming} onClick={() => { setError(null); void claimNext(); }}>重试加载</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-y-auto min-[900px]:overflow-hidden" data-testid="grading-workspace">
      {/* 顶部栏 */}
      <div className="flex min-h-13 items-center gap-3 max-[899px]:flex-wrap max-[600px]:gap-2 border-b border-border-subtle bg-card px-4 py-2 max-[899px]:sticky max-[899px]:top-0 max-[899px]:z-20">
        <Button variant="outline" icon={<ArrowLeft />} disabled={saving || claiming} onClick={onBack}>返回</Button>
        <div className="min-w-0 flex-1 truncate text-base font-medium text-foreground max-[600px]:order-4 max-[600px]:basis-full">
          {current?.blockTitle || blockId}
        </div>
        <div className="flex items-center gap-1 text-xs" aria-label="切换待阅和已阅试卷">
          <Button variant={queueView==="pending"?"primary":"outline"} size="sm" onClick={() => {
            const index=queue.findIndex(item=>!submittedIds.has(item.id));
            setQueueView("pending");if(index>=0)goTo(index);
          }}>待阅 {pendingCount}</Button>
          <Button variant={queueView==="reviewed"?"primary":"outline"} size="sm" onClick={() => {
            const index=queue.map(item=>item.id).reduce((last,id,index)=>submittedIds.has(id)?index:last,-1);
            setQueueView("reviewed");if(index>=0)goTo(index);
          }}>已阅 {reviewedCount}</Button>
        </div>
        {isCurrentSubmitted && current && (
          <Button variant="outline" size="sm" onClick={() => {
            setDraftScores(prev => ({...prev, [current.id]: current.score ?? 0}));
            document.getElementById("grading-score-section")?.scrollIntoView({behavior:"smooth", block:"center"});
          }}>重阅/修改分数</Button>
        )}
        <div className="text-sm font-medium text-muted-foreground tabular-nums max-[600px]:order-5 max-[600px]:w-full max-[600px]:text-xs">
          本次已提交 {completed} 份 · 待评 {pendingCount} 份
        </div>
        {current && <div className="hidden max-[899px]:order-6 max-[899px]:flex max-[899px]:w-full max-[899px]:items-center max-[899px]:justify-between max-[899px]:gap-2" aria-label="答卷浏览">
          <span className="min-w-0 text-xs font-semibold text-muted-foreground tabular-nums">
            流水号：{current.serialNumber??"—"}
            {isCurrentSubmitted && current.score !== null && <span className="ml-1 font-normal">已阅 {current.score} 分</span>}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="min-h-11 px-3"
              disabled={saving || claiming || currentIndex <= 0}
              onClick={() => goTo(currentIndex - 1)}>上一张</Button>
            <Button variant="outline" size="sm" className="min-h-11 px-3"
              disabled={saving || claiming || (currentIndex >= queue.length - 1 && !isCurrentSubmitted)}
              onClick={() => {
                if (currentIndex < queue.length - 1) goTo(currentIndex + 1);
                else void continueToNext();
              }}>下一张</Button>
          </div>
        </div>}

      </div>

      {/* 主体 — PAD/移动端响应式：<900px 上下分栏，≥900px 左右分栏 */}
      <div className="grid flex-none grid-cols-1 overflow-visible min-[900px]:min-h-0 min-[900px]:flex-1 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(320px,30%)] min-[900px]:grid-rows-1 min-[900px]:overflow-hidden">
        {/* 左侧: 图片区 */}
        <div className="flex h-[45dvh] min-h-[280px] min-w-0 flex-col overflow-hidden bg-secondary min-[900px]:h-auto min-[900px]:min-h-0">
          {/* 盲评只显示任务流水号，不显示学生身份。 */}
          {current && (
            <div className="hidden items-center justify-between gap-2 px-3 py-1.5 text-sm text-muted-foreground min-[900px]:flex">
              <span className="min-w-0 font-semibold tabular-nums">
                流水号：{current.serialNumber??"—"}
                {isCurrentSubmitted && current.score !== null && <span className="ml-2 text-xs font-normal">已阅 {current.score} 分</span>}
              </span>
              <div className="flex shrink-0 items-center gap-2" aria-label="答卷浏览">
                <Button variant="outline" size="sm" className="min-h-11 px-3 min-[900px]:min-h-9"
                  disabled={saving || claiming || currentIndex <= 0}
                  onClick={() => goTo(currentIndex - 1)}>上一张</Button>
                <Button variant="outline" size="sm" className="min-h-11 px-3 min-[900px]:min-h-9"
                  disabled={saving || claiming || (currentIndex >= queue.length - 1 && !isCurrentSubmitted)}
                  onClick={() => {
                    if (currentIndex < queue.length - 1) goTo(currentIndex + 1);
                    else void continueToNext();
                  }}>下一张</Button>
              </div>
            </div>
          )}

          {/* 图片区域 */}
          <div
            ref={imageRef}
            className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto p-3" aria-label="学生答卷"
            onWheel={handleWheel}
          >
            {current && !imageReady && (
              <div className="absolute inset-x-3 top-3 z-10 rounded-lg bg-card p-3 text-sm" role="status">
                {imageFailedId === current.id ? <button type="button" onClick={() => {
                  setImageFailedId(null);
                  const img = imageRef.current?.querySelector("img");
                  if (img) img.src = mediaUrl(current.imageUrl) + "?retry=" + Date.now();
                }}>图片加载失败，点击重试</button> : "正在加载答卷…"}
              </div>
            )}
            {current && saving && (
              <div className="absolute inset-x-3 top-3 z-20 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium shadow-sm" role="status">
                {claiming ? "分数已保存，正在打开下一份试卷…" : "正在保存分数…"}
              </div>
            )}
            {current && (
              <div
                className="relative origin-center transition-transform duration-(--px-dur-2) ease-standard"
                // 动态缩放/旋转（EXECUTION-PLAN §1.3 允许的动态值内联）
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              >
                <img
                  key={current.id}
                  data-testid="student-answer"
                  src={prefetchedUrls.current.get(current.id) ?? mediaUrl(current.imageUrl)}
                  onLoad={() => { setImageReadyId(current.id); setImageFailedId(null); }}
                  decoding="async"
                  alt={current.blockTitle || "作答切块"}
                  className="block max-w-full"
                  draggable={false}
                  // 跨源模式回看早期切块时，缓存的票据可能已被服务端淘汰 → 重签一次再试
                  onError={(event) => {
                    prefetchedUrls.current.delete(current.id);
                    if (!retryMediaTicketImage(event.currentTarget)) {
                      decoded.current.delete(current.id); setImageReadyId(null); setImageFailedId(current.id);
                    }
                  }}
                />
                <AnnotationOverlay
                  key={current.id}
                  cropId={current.id}
                  imageWidth={current.widthPx || 800}
                  imageHeight={current.heightPx || 600}
                  mode={annotateMode}
                  existingAnnotations={annotations}
                  onSaveAnnotation={handleSaveAnnotation}
                />
              </div>
            )}
          </div>

          {/* 工具栏 */}
          <div className="flex min-h-12 items-center gap-2 overflow-x-auto border-t border-border-subtle px-4 py-2">
            <Button variant="ghost" size="icon" aria-label="缩小" onClick={zoomOut}><ZoomOut /></Button>
            <span className="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <Button variant="ghost" size="icon" aria-label="放大" onClick={zoomIn}><ZoomIn /></Button>
            <div className="h-5 w-px bg-border" aria-hidden />
            <Button variant="ghost" size="icon" aria-label="逆时针旋转" onClick={rotateCCW}><RotateCcw /></Button>
            <Button variant="ghost" size="icon" aria-label="顺时针旋转" onClick={rotateCW}><RotateCw /></Button>
            <div className="h-5 w-px bg-border" aria-hidden />
            <Button
              variant="ghost"
              size="icon"
              aria-label="批注"
              aria-pressed={Boolean(annotateMode)}
              className={cn(annotateMode && "bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground")}
              onClick={() => setAnnotateMode(annotateMode ? false : (isTouchDevice ? "drawing" : "text"))}
            >
              <PenLine />
            </Button>
          </div>
        </div>

        {/* 右侧: 打分面板 */}
        <div className="flex min-h-0 min-w-0 flex-col border-t border-border-subtle min-[900px]:border-l min-[900px]:border-t-0">
          <section className={cn("flex flex-none flex-col min-[900px]:min-h-0 min-[900px]:flex-1",
            showMobileReference && "max-[899px]:h-[25dvh] max-[899px]:overflow-hidden")}
            aria-label="参考答案与评分标准" data-testid="grading-reference">
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
              <h2 className="text-base font-semibold">参考答案与评分标准</h2>
              <div className="flex items-center gap-3">
                {maxScore >= 10 && <button type="button" className="text-xs text-primary min-[900px]:hidden"
                  aria-expanded={mobileReferenceExpanded} onClick={() => setMobileReferenceExpanded(value => !value)}>
                  {mobileReferenceExpanded ? "收起标准" : "查看标准"}
                </button>}
                <button type="button" className="text-xs text-primary" onClick={() => void loadReference()}>刷新答案</button>
              </div>
            </div>
            <div className={cn("px-4 py-3 min-[900px]:min-h-0 min-[900px]:flex-1 min-[900px]:overflow-auto",
              "max-[899px]:min-h-0 max-[899px]:flex-1 max-[899px]:overflow-auto",
              !showMobileReference && "max-[899px]:hidden")}>
              {referenceError ? <button type="button" className="text-sm text-destructive-fg" onClick={() => void loadReference()}>答案加载失败，点击重试：{referenceError}</button> :
                !reference ? <p className="text-sm text-muted-foreground">正在加载本题参考答案…</p> :
                reference.questions.filter(q => q.answerText).map(q => (
                  <article key={q.questionNumber} className="mb-4">
                    <h3 className="mb-2 text-sm font-semibold">第{q.questionNumber}题{reference.questions.length === 1 ? ` · 满分 ${maxScore} 分` : ""}</h3>
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-7">
                      {q.answerText}
                    </p>
                  </article>
                ))}
              {reference?.answerPages.length ? (
                <details className="border-t border-border-subtle pt-2">
                  <summary className="cursor-pointer text-sm text-primary">查看完整答案原件</summary>
                  <div className="my-2 flex flex-wrap gap-2">
                    {reference.answerPages.map(page => <button type="button" key={page.pageIndex} className="rounded border border-border px-2 py-1 text-xs" onClick={() => setReferenceFile(page.pageIndex)}>
                      原件{page.pageIndex}
                    </button>)}
                  </div>
                  {referenceFile !== null && (
                    <iframe title="完整答案原件" className="h-80 w-full border-0" src={mediaUrl(`/api/exams/${examId}/answer-key/pages/${referenceFile}/image`)} />
                  )}
                </details>
              ) : null}
            </div>
          </section>
          <section id="grading-score-section" className="shrink-0 border-t border-border-subtle px-4 py-3 max-[899px]:max-h-[40dvh] max-[899px]:overflow-y-auto min-[900px]:max-h-[38vh] min-[900px]:overflow-auto" aria-label="本题打分">
          {currentAiSuggestion && (
            <div className="mb-3 rounded-lg border border-border bg-secondary px-3 py-3" aria-label="AI建议评分">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">AI建议评分：{currentAiSuggestion.score} / {currentAiSuggestion.maxScore} 分</strong>
                <Button variant="outline" size="sm" loading={adoptingAi} disabled={adoptingAi || saving || claiming}
                  onClick={() => void adoptAiSuggestion()}>采用AI评分</Button>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{currentAiSuggestion.reason}</p>
            </div>
          )}
          {scoringMode === "per_question" ? (
            <div className="rounded-lg bg-destructive-soft px-3.5 py-3 text-base text-destructive-fg">
              本题块配置为「逐题评分」模式，请使用在线阅卷逐题输入；如需在此面板打分，请管理员将评分模式改为「题块总分」。
            </div>
          ) : (
            <ScorePad
              maxScore={maxScore}
              hasHalfPoint={current?.hasHalfPoint === 1}
              currentScore={currentScore}
              onScoreChange={handleScoreChange}
              onSubmit={handleSubmit}
              disabled={saving || claiming || !imageReady}
            />
          )}



          </section>
          <div className="shrink-0 px-4 pb-2">
          {/* 错误提示 */}
          {error && (
            <div
              className={cn(
                "mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
                errorTone === "success"
                  ? "bg-success-soft text-success-foreground"
                  : "bg-destructive-soft text-destructive-fg",
              )}
              role="status"
            >
              {errorTone === "success"
                ? <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                : <AlertTriangle className="size-4 shrink-0" aria-hidden />}
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <Button
            variant="primary"
            block
            className="mb-2 min-h-14 text-lg [touch-action:manipulation]"
            icon={<Save className="size-5" />}
            loading={saving}
            disabled={!current || claiming || !imageReady || scoringMode === "per_question" || (!hasEnteredScore && !isCurrentSubmitted)}
            onClick={() => {
              if (isCurrentSubmitted && !hasEnteredScore) void continueToNext();
              else void handleSubmit();
            }}
          >
            {saving ? (claiming ? "分数已保存，切换中..." : "保存中...")
              : isCurrentSubmitted && !hasEnteredScore ? "继续下一份"
              : isCurrentSubmitted ? "更新分数并下一份"
              : "保存并下一份"}
          </Button>

          </div>
          <div className="hidden shrink-0 border-t border-border-subtle py-2 min-[900px]:flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Kbd>Enter</Kbd> 保存并下一份 · <Kbd>←</Kbd> <Kbd>→</Kbd> 翻页 · Ctrl + 滚轮缩放
          </div>
        </div>
      </div>
    </div>
  );
}
