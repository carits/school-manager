import {gradeObjectiveQuestion} from "./grading";
import type {ObjectiveScoringRule,AnswerCard} from "./types";
export type PdfRect = {x:number;y:number;width:number;height:number};
export type PdfAnchor = {rect:PdfRect;center?:{x:number;y:number}};
export type PdfPage = {pageRole:string;widthPt:number;heightPt:number;anchorCandidates:PdfAnchor[];sourcePdfPage?:number;viewRotation?:0|90|180|270};
export type PdfIdentity = {pageRole:string;fieldType:"manual"|"qr"|"barcode"|"omr_digits"|"student_number_ocr"|"name_ocr";rect?:PdfRect;length?:number;cells?:{column:number;value:string;rect:PdfRect}[]};
export type PdfQuestion = {questionId:string;blockId?:string;displayNumber:string;gradingType:"objective"|"teacher_score";pageRole?:string;maxScore:number;selectionType?:"single"|"multiple";answer:string[]|null;scoringRule?:{type:"exact_match"|"partial";partialScore?:number}|{type:"legacy_rule";rule:ObjectiveScoringRule};options?:{label:string;rect:PdfRect}[];regions?:{pageRole:string;order:number;rect:PdfRect}[]};
export type PdfTemplate = {format:"legacy-pdf-template-v1";title:string;subject?:string;coordinateSystem:"normalized_top_left";pages:PdfPage[];identities:PdfIdentity[];questions:PdfQuestion[];pairing:{suggestedMode:"interleaved_duplex";confirmationRequired:true;preserveSourceOrder:true}};
export function normalizePdfTemplate(input:any):PdfTemplate {
 const t:PdfTemplate={...input,format:"legacy-pdf-template-v1",title:String(input.title||"自定义答题卡"),coordinateSystem:"normalized_top_left",identities:input.identities||[input.identity].filter(Boolean),questions:(input.questions||[]).map((q:any)=>({...q,displayNumber:String(q.displayNumber??q.questionId.replace(/^q/,"")),pageRole:q.pageRole||input.pages?.[0]?.pageRole,answer:q.answer??q.answerKey??null,scoringRule:q.scoringRule||{type:"exact_match"}})),pairing:{suggestedMode:"interleaved_duplex",confirmationRequired:true,preserveSourceOrder:true}};
 return t;
}
export function validatePdfTemplate(t:PdfTemplate,publish=false):string[] {
 const e:string[]=[];const roles=new Set((t.pages||[]).map(p=>p.pageRole));const ids=new Set<string>();const nums=new Set<string>();
 const rect=(r:any,path:string)=>{if(!r||!["x","y","width","height"].every(k=>typeof r[k]==="number"&&Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1.00001||r.y+r.height>1.00001)e.push(path+"：区域必须在页面范围内");};
 if(!t.pages?.length||roles.size!==t.pages.length)e.push("页面角色不能为空或重复");
 for(const p of t.pages||[]){if(![0,90,180,270].includes(p.viewRotation||0))e.push("模板页方向无效");if(!(p.widthPt>0&&p.heightPt>0))e.push(p.pageRole+"：页面尺寸无效");if(publish&&p.anchorCandidates?.length!==4)e.push(p.pageRole+"：须配置四个定位点");for(const a of p.anchorCandidates||[])rect(a.rect,p.pageRole+"定位点");}
 for(const f of t.identities||[]){if(!roles.has(f.pageRole))e.push("身份区域页码无效");if(f.fieldType==="omr_digits"){const n=Number(f.length);if(!Number.isInteger(n)||n<1||n>20)e.push("考号位数须为1～20");for(const c of f.cells||[])rect(c.rect,"考号格");if(publish){for(let col=1;col<=n;col++){const vals=(f.cells||[]).filter(c=>c.column===col).map(c=>c.value);if(new Set(vals).size!==10||!Array.from({length:10},(_,i)=>String(i)).every(v=>vals.includes(v)))e.push("考号第"+col+"列需要0～9十个格");}}}else if(f.fieldType==="manual"){}else if(f.rect)rect(f.rect,"身份区域");else if(publish)e.push("身份区域缺少坐标");}
 if(publish&&!t.identities?.length)e.push("至少配置一种身份识别区域");
 if(publish&&!t.questions?.length)e.push("至少配置一道题");
 for(const q of t.questions||[]){if(!q.questionId||ids.has(q.questionId))e.push("题目ID重复或缺失");ids.add(q.questionId);if(!/^\d+$/.test(q.displayNumber)||Number(q.displayNumber)<1||nums.has(String(Number(q.displayNumber))))e.push("题号须为不重复的正整数");nums.add(String(Number(q.displayNumber)));if(!Number.isFinite(q.maxScore)||q.maxScore<=0)e.push("第"+q.displayNumber+"题满分无效");
 if(q.gradingType==="objective"){if(!roles.has(q.pageRole||""))e.push("客观题页面无效");for(const o of q.options||[])rect(o.rect,"第"+q.displayNumber+"题选项");const labels=(q.options||[]).map(o=>o.label);if(publish&&(labels.length<2||new Set(labels).size!==labels.length))e.push("第"+q.displayNumber+"题须配置不同选项");if(q.answer!=null&&(!Array.isArray(q.answer)||!q.answer.length||q.answer.some(a=>!labels.includes(a))||new Set(q.answer).size!==q.answer.length))e.push("标准答案含无效选项");if(q.selectionType!=="multiple"&&(q.answer?.length||0)>1)e.push("单选题只能有一个答案");if(q.scoringRule?.type==="legacy_rule"){const rule=q.scoringRule.rule as any;const bounded=(v:any)=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=q.maxScore;const map=(v:any)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.entries(v).every(([k,n])=>/^\d+$/.test(k)&&bounded(n));if(!rule||!["fixed_partial","per_selected_count","by_correct_count"].includes(rule.type)||(rule.wrongOrExtraScore!==undefined&&!bounded(rule.wrongOrExtraScore))||(rule.allowWrongOptions!==undefined&&typeof rule.allowWrongOptions!=="boolean")||(rule.type==="fixed_partial"&&!bounded(rule.partialScore))||(rule.type==="per_selected_count"&&!map(rule.partialScores))||(rule.type==="by_correct_count"&&(!rule.partialScoresByCorrectCount||!Object.values(rule.partialScoresByCorrectCount).every(map))))e.push("旧卡多选计分规则无效");}if(q.scoringRule?.type==="partial"&&(!(Number(q.scoringRule.partialScore)>0)||Number(q.scoringRule.partialScore)>q.maxScore))e.push("多选部分分无效");
 }else if(q.gradingType==="teacher_score"){if(publish&&!q.regions?.length)e.push("第"+q.displayNumber+"题缺少答题区域");for(const a of q.regions||[]){if(!roles.has(a.pageRole))e.push("主观题页面无效");rect(a.rect,"第"+q.displayNumber+"题");}}else e.push("未知题型");}
 return [...new Set(e)];
}
export function objectivePdfScore(q:PdfQuestion,value:string[]):number|null {
 if(!q.answer?.length)return null;
 const v=[...new Set(value)].sort(),a=[...new Set(q.answer)].sort();
 if(q.selectionType!=="multiple"&&v.length>1)return 0;
 if(q.scoringRule?.type==="legacy_rule"){const block:any={id:q.blockId||q.questionId,type:"objective",mode:q.selectionType||"single",optionCount:q.options?.length||4,scorePerQuestion:q.maxScore,questionStart:Number(q.displayNumber),questionCount:1,questions:[{questionNumber:Number(q.displayNumber),mode:q.selectionType||"single",optionCount:q.options?.length||4,score:q.maxScore,answerKey:q.answer,scoringRule:q.scoringRule.rule}]};return gradeObjectiveQuestion({bodyBlocks:[block]} as AnswerCard,{questionNumber:Number(q.displayNumber),selectedOptions:v,confidence:1},0).score;}
 if(v.length===a.length&&v.every((x,i)=>x===a[i]))return q.maxScore;
 if(q.selectionType==="multiple"&&q.scoringRule?.type==="partial"&&v.length>0&&v.length<a.length&&v.every(x=>a.includes(x)))return Number(q.scoringRule.partialScore||0);
 return 0;
}
