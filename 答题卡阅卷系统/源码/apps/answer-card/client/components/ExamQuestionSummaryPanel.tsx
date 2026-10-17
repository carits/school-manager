import {useEffect,useState} from "react";
import {fetchJson} from "../auth/api";
import type {ExamQuestionSummary} from "../../../../shared/examPdfProgress";
import {Button,Input} from "./ui/v2";
export function ExamQuestionSummaryPanel({examId}:{examId:number}){
 const [data,setData]=useState<ExamQuestionSummary|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 const [search,setSearch]=useState(""),[appliedSearch,setAppliedSearch]=useState(""),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
 const [showHistory,setShowHistory]=useState(false);
 useEffect(()=>{setData(null);setPage(1);setSearch("");setAppliedSearch("");setShowHistory(false);},[examId]);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{
   if(document.visibilityState==="hidden"){timer=setTimeout(()=>void load(),10000);return;}
   setLoading(true);
   try{
    const res=await fetchJson<{ok:boolean;data:ExamQuestionSummary}>(`/api/review/exams/${examId}/question-summary?page=${page}&pageSize=50&search=${encodeURIComponent(appliedSearch)}`,{signal:controller.signal});
    if(!controller.signal.aborted){setData(res.data);setError("");}
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"逐题汇总加载失败");}
   finally{if(!controller.signal.aborted){setLoading(false);timer=setTimeout(()=>void load(),10000);}}
  };
  void load();return()=>{controller.abort();clearTimeout(timer);};
 },[examId,page,appliedSearch,refresh]);
 const score=(v:number|null)=>v==null?<span className="text-muted-foreground">待完成</span>:v;
 const questions=data?.questions.filter(q=>showHistory||!q.historical)??[];
 const hasHistory=data?.questions.some(q=>q.historical)??false;
 return <section className="rounded-lg border border-border-subtle bg-card p-4" aria-label="逐题成绩汇总">
  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
   <div><h3 className="font-semibold">逐题成绩汇总</h3><p className="mt-1 text-xs text-muted-foreground">0分正常显示，未识别或未评分显示待完成。合并阅卷按题组总分计入；历史小题分仅供回看。全部完成且身份确认后显示总分。</p></div>
   <Button variant="outline" size="sm" onClick={()=>setRefresh(v=>v+1)} disabled={loading}>刷新汇总</Button>
  </div>
  <form className="mb-3 flex gap-2" onSubmit={e=>{e.preventDefault();setPage(1);setAppliedSearch(search.trim());}}>
   <Input aria-label="搜索汇总学生" className="max-w-xs" placeholder="流水号、姓名或学号" value={search} onChange={e=>setSearch(e.target.value)}/>
   <Button type="submit" variant="outline" size="sm">搜索</Button>
  </form>
  {hasHistory&&<label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showHistory} onChange={e=>setShowHistory(e.target.checked)}/>显示合并前的历史小题分（不计入总分和完成进度）</label>}
  {error&&<p role="alert" className="mb-2 text-sm text-destructive-fg">{error}</p>}
  {loading&&!data?<p className="text-sm text-muted-foreground">正在加载逐题汇总…</p>:data&&data.total===0?<p className="text-sm text-muted-foreground">暂无匹配的自定义PDF扫描卷。</p>:data&&<>
   <div className="max-h-[65vh] overflow-auto rounded border border-border-subtle" aria-busy={loading}>
    <table className="w-max min-w-full border-collapse text-sm tabular-nums">
     <thead className="sticky top-0 z-20 bg-card shadow-sm"><tr>
      <th className="sticky left-0 z-30 min-w-24 bg-card p-3 text-left">流水号</th>
      <th className="min-w-24 p-3 text-left">姓名</th><th className="min-w-28 p-3 text-left">学号</th>
      {questions.map(q=><th key={q.number} className="min-w-20 p-2 text-center"><div>{q.title||`第${q.number}题`}</div><div className="mt-1 text-xs font-normal text-muted-foreground">{q.historical?"历史，不计入总分":q.groupId?"合并阅卷":q.kind==="objective"?"客观":"主观"} · {q.maxScore}分</div></th>)}
      <th className="min-w-24 p-2">客观题进度</th><th className="min-w-24 p-2">主观题进度</th><th className="min-w-24 p-2">客观题分</th><th className="min-w-24 p-2">主观题分</th><th className="min-w-24 p-2">总分</th>
     </tr></thead>
     <tbody>{data.rows.map(r=><tr key={r.paperId} className="border-t border-border-subtle hover:bg-muted/30">
      <td className="sticky left-0 z-10 bg-card p-3 font-semibold">{r.serialNumber??"—"}{r.reprocessing&&<div className="text-xs font-normal text-muted-foreground">重识别中</div>}</td>
      <td className="p-3">{r.studentName||"未绑定学生"}{!r.identityConfirmed&&<div className="text-xs text-muted-foreground">待确认</div>}</td><td className="p-3">{r.studentNumber||"身份待确认"}</td>
      {questions.map(q=><td key={q.number} className="p-2 text-center">{q.historical&&r.scores[q.number]==null?<span className="text-muted-foreground">—</span>:Object.hasOwn(r.scores,q.number)?score(r.scores[q.number]):<span className="text-muted-foreground">—</span>}</td>)}
      <td className="p-2 text-center">{r.objectiveDone}/{r.objectiveRequired}</td><td className="p-2 text-center">{r.subjectiveDone}/{r.subjectiveRequired}</td>
      <td className="p-2 text-center">{score(r.objectiveScore)}</td><td className="p-2 text-center">{score(r.subjectiveScore)}</td><td className="p-2 text-center font-semibold">{score(r.totalScore)}</td>
     </tr>)}</tbody>
    </table>
   </div>
   <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
    <span>共 {data.total} 份卷 · 每页 {data.pageSize} 份{loading?" · 更新中…":" · 每10秒自动更新"}</span>
    <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page<=1||loading} onClick={()=>{setData(null);setPage(v=>v-1);}}>上一页</Button><span>{page} / {Math.max(1,Math.ceil(data.total/data.pageSize))}</span><Button size="sm" variant="outline" disabled={page*data.pageSize>=data.total||loading} onClick={()=>{setData(null);setPage(v=>v+1);}}>下一页</Button></div>
   </div>
  </>}
 </section>;
}
