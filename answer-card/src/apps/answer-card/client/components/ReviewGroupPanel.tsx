import React,{useCallback,useEffect,useMemo,useRef,useState} from "react";
import {authFetch,fetchJson} from "../auth/api";
import {createReviewImageCache} from "../util/reviewGroupImageCache";
import "./ReviewGroupPanel.css";
type Old={questionNumber:number;score:number|null;maxScore:number;reviewerName:string|null;reviewedAt:string|null};
type Item={serialNumber:number;paperId:string;score:number|null;version:number;inputSignature:string;status:"ready"|"reviewed";claimedBy:number|null;imageUrl:string;oldScores:Old[];maxScore:number;title:string};
type Group={id:string;title:string;questionNumbers:number[];maxScore:number;mode:string;assignedCount:number;pendingCount:number;reviewedCount:number;heldCount:number};
type Ai={score:number;maxScore:number;reasons:{questionNumber:number;score:number;reason:string}[];suggestionIds:string[]};
type Reference={questions:{questionNumber:number;answerText:string}[]};
const post=<T,>(url:string,body:unknown)=>fetchJson<T>(url,{method:"POST",body:JSON.stringify(body)});
type ImageSession={cache:ReturnType<typeof createReviewImageCache>;before:Item[];current:Item|null;ahead:Item[]};
// Navigation unmounts the panel. Keep its seven-image window until this teacher
// finishes the group; separate teachers/exams/groups never share a cache.
const imageSessions=new Map<string,ImageSession>();
function imageSession(key:string){
 let session=imageSessions.get(key);
 if(!session){session={before:[],current:null,ahead:[],cache:createReviewImageCache(async(url,signal)=>{
   const response=await authFetch(url,{signal});if(!response.ok)throw new Error("答卷图片读取失败："+response.status);
   return URL.createObjectURL(await response.blob());
 },url=>URL.revokeObjectURL(url))};imageSessions.set(key,session)}
 return session;
}
export function ReviewGroupPanel({examId,groupId,teacherId,onBack}:{examId:number;groupId:string;teacherId:number;onBack:()=>void}){
 const base=`/api/review-groups/exams/${examId}/groups/${groupId}`;
 const sessionKey=`review-group-position:${teacherId}:${examId}:${groupId}`;
 const session=useMemo(()=>imageSession(sessionKey),[sessionKey]);
 const [group,setGroup]=useState<Group|null>(null),[item,setItem]=useState<Item|null>(null),[reviewed,setReviewed]=useState<Item[]>([]);
 const [reference,setReference]=useState<Reference|null>(null),[ai,setAi]=useState<Ai|null>(null),[draft,setDraft]=useState<number|null>(null);
 const [image,setImage]=useState<string|null>(null),[busy,setBusy]=useState(false),[initialLoading,setInitialLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [view,setView]=useState<"pending"|"reviewed">("pending");
 const [zoom,setZoom]=useState(100);
 const [teacherExpanded,setTeacherExpanded]=useState(true),[aiExpanded,setAiExpanded]=useState(true);
 const currentRef=useRef<Item|null>(null),busyRef=useRef(false),showSeq=useRef(0),requestRef=useRef<{key:string;id:string}|null>(null);
 const imageCache=session.cache;
 const imageFor=useCallback((i:Item)=>imageCache.get(i.imageUrl),[imageCache]);
 const show=useCallback(async(i:Item|null)=>{
   const sequence=++showSeq.current;
   if(currentRef.current?.serialNumber!==i?.serialNumber)requestRef.current=null;
   currentRef.current=i;setItem(i);setDraft(null);setAi(null);setImage(null);setError("");
   if(!i)return;
   if(session.current&&session.current.serialNumber!==i.serialNumber)
     session.before=[...session.before.filter(p=>p.serialNumber!==i.serialNumber&&p.serialNumber!==session.current!.serialNumber),session.current].slice(-3);
   const aheadIndex=session.ahead.findIndex(p=>p.serialNumber===i.serialNumber);
   session.ahead=aheadIndex>=0?session.ahead.slice(aheadIndex+1):session.current?.serialNumber===i.serialNumber?session.ahead:[];
   session.current=i;
   try{localStorage.setItem(sessionKey,String(i.serialNumber))}catch{}
   imageCache.setActive(i.imageUrl);
   imageCache.retain([i,...session.before,...session.ahead].map(p=>p.imageUrl));
   try {
     // Start the next image while the current image is downloading. Navigation
     // reuses this same promise even if the preview has not finished yet.
     const loading=imageFor(i);
     void fetchJson<{ok:boolean;data:Item[]}>(`${base}/next-previews?afterSerial=${i.serialNumber}`)
       .then(async r=>{
         if(showSeq.current!==sequence)return;
         const past=new Set(session.before.map(p=>p.serialNumber));
         session.ahead=r.data.filter(p=>p.serialNumber!==i.serialNumber&&!past.has(p.serialNumber)).slice(0,3);
         imageCache.retain([i,...session.before,...session.ahead].map(p=>p.imageUrl));
         // Next-first priority; at most the current image and one preview download.
         for(const upcoming of session.ahead){if(showSeq.current!==sequence)break;await imageFor(upcoming)}
       }).catch(()=>{});
     const url=await loading;
     if(showSeq.current!==sequence)return;
     setImage(url);
     void fetchJson<{ok:boolean;data:Ai|null}>(`${base}/papers/${i.serialNumber}/ai`)
       .then(r=>{if(showSeq.current===sequence)setAi(r.data)}).catch(()=>{});
   }catch(e){if(showSeq.current===sequence)setError(e instanceof Error?e.message:String(e))}
 },[base,imageFor,imageCache,session,sessionKey]);
 const clearCompleted=useCallback(()=>{
   imageCache.clear();session.before=[];session.ahead=[];session.current=null;
   try{localStorage.removeItem(sessionKey)}catch{}
 },[imageCache,session,sessionKey]);
 const refresh=useCallback(async()=>{
   const [groups,ref]=await Promise.all([
     fetchJson<{ok:boolean;groups:Group[]}>(`/api/review-groups/exams/${examId}`),
     fetchJson<{ok:boolean;data:Reference}>(`${base}/reference`)
   ]);
   const selected=groups.groups.find(g=>g.id===groupId);if(!selected)throw new Error("题组暂不可用，请返回题块列表刷新");
   setGroup(selected);setReference(ref.data);
   if(selected.assignedCount>0&&selected.pendingCount===0)clearCompleted();
 },[base,examId,groupId,clearCompleted]);
 const claimNext=useCallback(async(afterSerial?:number)=>{
   const r=await post<{ok:boolean;data:Item|null}>(`${base}/claim-next`,{afterSerial});
   await show(r.data);
   if(!r.data)await refresh();
   return r.data;
 },[base,show,refresh]);
 useEffect(()=>{let alive=true;(async()=>{
   try{await refresh();if(alive){
     let resume=session.current?.serialNumber;
     if(!resume)try{const n=Number(localStorage.getItem(sessionKey));if(Number.isSafeInteger(n)&&n>0)resume=n}catch{}
     if(resume){try{const r=await post<{ok:boolean;data:Item}>(`${base}/papers/${resume}/claim`,{});if(alive)await show(r.data);return}catch{/* Revalidate access and recover from stale positions through the normal queue. */}}
     if(alive)await claimNext();
   }}
   catch(e){if(alive)setError(e instanceof Error?e.message:String(e))}
   finally{if(alive)setInitialLoading(false)}
 })();return()=>{alive=false;showSeq.current++}},[refresh,claimNext,base,show,session,sessionKey]);
 const nextClick=async()=>{
   if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");setView("pending");
   try{await claimNext(item?.serialNumber)}catch(e){setError(e instanceof Error?e.message:String(e))}
   finally{busyRef.current=false;setBusy(false)}
 };
 const openReviewed=async()=>{
   if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");
   try{const r=await fetchJson<{ok:boolean;data:Item[]}>(`${base}/reviewed`);setReviewed(r.data);setView("reviewed");await show(null)}
   catch(e){setError(e instanceof Error?e.message:String(e))}
   finally{busyRef.current=false;setBusy(false)}
 };
 const selectReviewed=async(serial:number)=>{
   if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");
   try{const r=await post<{ok:boolean;data:Item}>(`${base}/papers/${serial}/claim`,{});await show(r.data)}
   catch(e){setError(e instanceof Error?e.message:String(e))}
   finally{busyRef.current=false;setBusy(false)}
 };
 const save=async()=>{
   const i=currentRef.current;if(!i||draft===null||!image||busyRef.current)return;
   busyRef.current=true;setBusy(true);setError("");setNotice("");
   let committed=false;
   try{
     const requestKey=`${i.paperId}:${i.version}:${i.inputSignature}:${draft}`;
     if(requestRef.current?.key!==requestKey)requestRef.current={key:requestKey,id:crypto.randomUUID()};
     const requestId=requestRef.current.id;
     const r=await post<{ok:boolean;data:Item;paperTotalScore:number|null;reused:boolean}>(`${base}/papers/${i.serialNumber}/submit`,
       {score:draft,version:i.version,inputSignature:i.inputSignature,requestId});
     committed=true;requestRef.current=null;
     currentRef.current=r.data;setItem(r.data);setDraft(null);
     setNotice(`流水号 ${i.serialNumber} 已保存 ${draft} 分`);
     setGroup(g=>g?{...g,reviewedCount:g.reviewedCount+(i.status==="ready"?1:0),pendingCount:Math.max(0,g.pendingCount-(i.status==="ready"?1:0))}:g);
     setReviewed(items=>[r.data,...items.filter(x=>x.serialNumber!==i.serialNumber)]);
     setView("pending");
     await claimNext(i.serialNumber);
   }catch(e){setError(committed?"分数已保存，下一份暂未打开；请点“待评下一份”重试。":e instanceof Error?e.message:String(e))}
   finally{busyRef.current=false;setBusy(false)}
 };
 const adopt=async()=>{
   const i=currentRef.current;if(!i||!ai||!image||busyRef.current)return;
   busyRef.current=true;setBusy(true);setError("");
   try{const r=await post<{ok:boolean;data:Ai;formalScoreWritten:false}>(`${base}/papers/${i.serialNumber}/adopt-ai`,{suggestionIds:ai.suggestionIds});
     if(r.formalScoreWritten===false){setDraft(r.data.score);setNotice("AI分数已填入草稿；点击“保存并下一份”后才计入正式成绩")}}
   catch(e){setError(e instanceof Error?e.message:String(e))}
   finally{busyRef.current=false;setBusy(false)}
 };
 const saveRef=useRef<()=>Promise<void>>(save);saveRef.current=save;
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.key==="Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement) && (!(e.target instanceof HTMLButtonElement) || e.target.hasAttribute("data-score-key"))){e.preventDefault();void saveRef.current()}};
   window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler)},[]);
 const numbers=Array.from({length:21},(_,i)=>i/2);
 return <div className="review-group-panel flex h-screen flex-col bg-background text-foreground">
   <header className="flex items-center gap-3 border-b px-4 py-3">
     <button type="button" onClick={onBack} className="rounded border px-3 py-1">返回题块</button>
     <strong>{group?.title||"正在打开题组…"}</strong>
     <span className="text-sm text-muted-foreground">{group?"已评 "+group.reviewedCount+" / 分配 "+group.assignedCount+" 份":"正在加载进度…"}</span>
     <button type="button" onClick={()=>void nextClick()} disabled={busy||initialLoading} className="ml-auto rounded border px-3 py-1">{busy?"正在打开…":"待评下一份"}</button>
     <button type="button" onClick={()=>void openReviewed()} disabled={busy} className="rounded border px-3 py-1">已评回看</button>
   </header>
   {error&&<div role="alert" className="bg-red-100 px-4 py-2 text-red-800">{error}</div>}
   {notice&&<div role="status" className="bg-green-100 px-4 py-2 text-green-800">{notice}</div>}
   {view==="reviewed"&&!item?<div className="overflow-auto p-5">
      <h2 className="mb-4 font-medium">我已评的试卷</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{reviewed.map(x=><button type="button" key={x.serialNumber} onClick={()=>void selectReviewed(x.serialNumber)} className="rounded border p-3 text-left">流水号 {x.serialNumber}<br/>已给 {x.score} 分</button>)}</div>
      {!reviewed.length&&<p>暂无已评试卷。</p>}
   </div>:!item?<div className="p-6">{initialLoading?"正在打开第一份试卷…":error?"请返回题块列表刷新后重试。":"当前没有待评试卷。可点“已评回看”查看或改分。"}</div>:
   <main className="review-group-workspace">
     <section className="review-group-paper">
       <div className="review-group-image-toolbar">
         <strong>流水号 {item.serialNumber} · {item.title}</strong>
         <div><button type="button" aria-label="缩小答卷" disabled={zoom<=60} onClick={()=>setZoom(z=>Math.max(60,z-20))}>−</button><button type="button" onClick={()=>setZoom(100)}>适应宽度 {zoom}%</button><button type="button" aria-label="放大答卷" disabled={zoom>=200} onClick={()=>setZoom(z=>Math.min(200,z+20))}>＋</button></div>
       </div>
       <div className="review-group-image-scroll">
       {image?<img src={image} alt={`流水号 ${item.serialNumber} 的整组作答`} style={{width:`${zoom}%`}}/>:<div>加载答卷图片中…</div>}
       </div>
     </section>
     <aside className="review-group-sidebar">
       <div className="review-group-reference">
       <details className="review-group-standard"><summary>参考答案与评分标准</summary>
         <div className="review-group-answers">{reference?.questions.map(q=><div key={q.questionNumber} className="border-b py-1"><b>第{q.questionNumber}题</b>：{q.answerText||"未录入"}</div>)}</div>
       </details>
       <section className="review-group-teacher"><button type="button" className="review-group-disclosure" aria-expanded={teacherExpanded} aria-controls="review-group-old-scores" onClick={()=>setTeacherExpanded(v=>!v)}>{teacherExpanded?"▾":"▸"} 合并前教师评分（只作参考）</button>
         {teacherExpanded&&<div id="review-group-old-scores" className="review-group-old-scores">{item.oldScores.map(x=><div key={x.questionNumber} title={x.reviewedAt?`评分时间：${new Date(x.reviewedAt).toLocaleString("zh-CN")}`:undefined}><span>第{x.questionNumber}题</span><b>{x.score===null?"未评":`${x.score}分`}</b>{x.reviewerName&&<small>{x.reviewerName}</small>}</div>)}</div>}
       </section>
       {ai&&<section className={`review-group-ai ${aiExpanded?"is-expanded":""}`}><button type="button" className="review-group-disclosure" aria-expanded={aiExpanded} aria-controls="review-group-ai-content" onClick={()=>setAiExpanded(v=>!v)}>{aiExpanded?"▾":"▸"} AI推荐分：{ai.score}分</button>
         {aiExpanded&&<><div id="review-group-ai-content" className="review-group-ai-content">{ai.reasons.map(x=><div key={x.questionNumber}><b>第{x.questionNumber}题 · {x.score}分：</b>{x.reason}</div>)}</div>
         <button type="button" onClick={()=>void adopt()} disabled={busy} className="review-group-adopt">采用AI评分（填草稿）</button></>}
       </section>}
       </div>
       <div className="review-group-scoring">
       <div className="review-group-score-summary"><span>整组总分 · 满分 {item.maxScore} 分<br/><small>正式分：{item.score===null?"未评":`${item.score}分`}</small></span><strong aria-live="polite">{draft===null?"请选择分数":`${draft} 分`}</strong></div>
       <div className="review-group-score-buttons">{numbers.map(n=><button type="button" key={n} data-score-key aria-pressed={draft===n} onClick={()=>setDraft(n)} className={draft===n?"bg-primary text-primary-foreground":""}>{n}</button>)}</div>
       <button type="button" onClick={()=>void save()} disabled={busy||draft===null||!image} className="review-group-save bg-primary text-primary-foreground disabled:opacity-50">保存并下一份 Enter</button>
       </div>
     </aside>
   </main>}
 </div>;
}
