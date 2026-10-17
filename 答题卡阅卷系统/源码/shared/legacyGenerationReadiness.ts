import type {PdfTemplate} from "./legacyPdf";
type Row=Record<string,any>;
export function legacyGenerationReadiness(def:PdfTemplate,papers:Row[]){
 const required=new Set(def.questions.filter(q=>q.gradingType==="teacher_score").flatMap(q=>(q.regions||[]).map(r=>r.pageRole)));
 let identityPending=0,pagePending=0;const eligibleIds:string[]=[];
 const issues=papers.flatMap(p=>{
  const reasons:string[]=[];
  if(p.identity_status!=="confirmed"||!p.ownership_confirmed||!p.student_id){identityPending++;reasons.push("身份或页归属未确认");}
  if([...required].some(role=>p.pages.filter((x:Row)=>x.page_role===role&&x.status==="recognized").length!==1)){pagePending++;reasons.push("主观题页面缺失、重复或未校正");}
  if(!reasons.length)eligibleIds.push(p.id);
  return reasons.length?[{paperId:p.id,sheetNo:p.sheet_no,studentNumber:p.student_number||p.autoIdentity?.studentNumber||"",studentName:p.student_name||p.autoIdentity?.name||"",reasons}]:[];
 });
 return {ready:eligibleIds.length>0,readyCount:eligibleIds.length,eligibleIds,identityPending,pagePending,answerPending:0,scorePending:0,missingKeys:def.questions.filter(q=>q.gradingType==="objective"&&!q.answer?.length).map(q=>q.displayNumber),papers:issues};
}
