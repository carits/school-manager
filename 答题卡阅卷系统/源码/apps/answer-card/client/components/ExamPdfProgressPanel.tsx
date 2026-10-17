import {useEffect,useState} from "react";
import {fetchJson} from "../auth/api";
import type {ExamPdfProgress} from "../../../../shared/examPdfProgress";
import {Button} from "./ui/v2";
export const legacyPdfEnabled=(import.meta as unknown as {env?:Record<string,string>}).env?.VITE_LEGACY_ONLY==="1";
export function useExamPdfProgress(examIds:number[],enabled=true){
 const key=[...new Set(examIds)].sort((a,b)=>a-b).slice(0,100).join(",");
 const [data,setData]=useState<Record<number,ExamPdfProgress>>({});
 const [error,setError]=useState("");const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  if(!legacyPdfEnabled||!enabled||!key)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  setData({});setError("");
  const load=async()=>{
   try{
    if(document.visibilityState!=="hidden"){
     const res=await fetchJson<{ok:boolean;data:ExamPdfProgress[]}>(`/api/review/processing-progress?examIds=${key}`,{signal:controller.signal});
     if(!controller.signal.aborted){setData(Object.fromEntries(res.data.map(p=>[p.examId,p])));setError("");}
    }
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"客观题进度加载失败");}
   finally{if(!controller.signal.aborted)timer=setTimeout(()=>void load(),10000);}
  };
  void load();return()=>{controller.abort();clearTimeout(timer);};
 },[key,enabled,refresh]);
 return {data,error,reload:()=>setRefresh(v=>v+1)};
}
export function ExamPdfProgressCard({progress,compact=false}:{progress:ExamPdfProgress;compact?:boolean}){
 const p=progress,percent=p.totalQuestions?Math.round(100*p.recognizedQuestions/p.totalQuestions):0;
 if(!p.totalPapers)return <span className="text-xs text-muted-foreground">暂无扫描卷</span>;
 if(compact)return <div className="min-w-44 text-xs tabular-nums">
  <div>识别 {p.recognizedPapers}/{p.totalPapers} 份 · 计分 {p.scoringCompletePapers}/{p.totalPapers} 份</div>
  <div className="mt-1 text-muted-foreground">待识别 {p.pendingPapers} · 排队 {p.queued} · 运行 {p.running}{p.failed>0&&<span className="text-destructive-fg"> · 失败任务 {p.failed}</span>}{p.pausedBatches>0&&" · 已暂停"}{p.manualWaitingBatches>0&&" · 待手动启动"}</div>
 </div>;
 return <section className="rounded-lg border border-border-subtle bg-card p-4" aria-label="客观题处理进度">
  <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">客观题处理进度</h3><span className="text-xs text-muted-foreground">每10秒自动更新 · 主观题阅卷可独立进行</span></div>
  <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
   <div>识别完成 <strong className="block text-xl tabular-nums">{p.recognizedPapers}/{p.totalPapers} 份</strong></div>
   <div>计分完成 <strong className="block text-xl tabular-nums">{p.scoringCompletePapers}/{p.totalPapers} 份</strong></div>
   <div>已识别小题 <strong className="block text-xl tabular-nums">{p.recognizedQuestions}/{p.totalQuestions}</strong></div>
   <div>已计分小题 <strong className="block text-xl tabular-nums">{p.scoredQuestions}/{p.totalQuestions}</strong></div>
  </div>
  <progress className="mt-3 h-2 w-full accent-primary" value={p.recognizedQuestions} max={Math.max(1,p.totalQuestions)} aria-label="客观题识别完成比例"/>
  <p className="mt-2 text-xs text-muted-foreground">识别 {percent}% · 待识别 {p.pendingPapers} 份 · 已识别待计分 {p.waitingScoreQuestions} 题 · 身份或页归属待确认 {p.identityPending} 份 · 排队 {p.queued} · 运行 {p.running} · 失败任务 {p.failed}</p>
  {(p.pausedBatches>0||p.manualWaitingBatches>0)&&<p className="mt-2 text-sm text-warning-foreground">{p.pausedBatches>0&&`${p.pausedBatches} 个批次已暂停。 `}{p.manualWaitingBatches>0&&`${p.manualWaitingBatches} 个批次为手动模式，尚未启动客观题。 `}可在自定义PDF对应扫描批次中启动、暂停或继续。</p>}
 </section>;
}
export function ExamPdfProgressPanel({examId}:{examId:number}){
 const {data,error,reload}=useExamPdfProgress([examId]);
 if(!legacyPdfEnabled)return null;
 return <div className="mb-5">{error?<div role="alert" className="text-sm text-destructive-fg">{error}<Button variant="outline" size="sm" onClick={reload}>重试</Button></div>:data[examId]?<ExamPdfProgressCard progress={data[examId]}/>:<p className="text-sm text-muted-foreground">正在加载客观题进度…</p>}</div>;
}
