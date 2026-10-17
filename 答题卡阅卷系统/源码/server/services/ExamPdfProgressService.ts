import {effectiveLegacyPaperScores,readReviewGroupScoreContext,legacyGroupedQuestionColumns} from "./LegacyReviewGroupScoreService";
import {createExamProgressReader} from "../../shared/examProgressReader";
import {getMysqlDb,type DbAdapter} from "../db";
import {normalizePdfTemplate,type PdfTemplate} from "../../shared/legacyPdf";
import type {ExamPdfProgress,ExamQuestionSummary,ExamQuestionColumn} from "../../shared/examPdfProgress";
type Row=Record<string,any>;
const parse=(v:any)=>typeof v==="string"?JSON.parse(v):v;
async function loadBatches(ids:number[],db:DbAdapter){
 if(!ids.length)return {batches:[] as Row[],defs:new Map<string,PdfTemplate>()};
 const batches=await db.all<Row>(`SELECT id,exam_id,template_id,original_name,objective_mode,objective_paused,objective_requested FROM legacy_pdf_batches WHERE exam_id IN (${ids.map(()=>"?").join(",")}) ORDER BY created_at,id`,...ids);
 const tids=[...new Set(batches.map(b=>String(b.template_id)))];
 const ts=tids.length?await db.all<Row>(`SELECT id,definition_json FROM legacy_pdf_templates WHERE id IN (${tids.map(()=>"?").join(",")})`,...tids):[];
 return {batches,defs:new Map(ts.map(t=>[String(t.id),normalizePdfTemplate(parse(t.definition_json))]))};
}

export async function ensureExamPdfProgressSchema(db:DbAdapter=getMysqlDb()){
 const col=await db.get<Row>("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='legacy_pdf_results' AND COLUMN_NAME='recognition_present'");
 if(!col)await db.exec("ALTER TABLE legacy_pdf_results ADD COLUMN recognition_present TINYINT AS (auto_value IS NOT NULL OR final_value IS NOT NULL) VIRTUAL, ALGORITHM=INSTANT");
 const index=await db.get<Row>("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='legacy_pdf_results' AND INDEX_NAME='legacy_objective_progress_read' LIMIT 1");
 if(!index)await db.exec("ALTER TABLE legacy_pdf_results ADD INDEX legacy_objective_progress_read(paper_id,question_id,recognition_present,status,score),ALGORITHM=INPLACE,LOCK=NONE");
}
export async function examPdfProgress(ids:number[],db:DbAdapter=getMysqlDb()):Promise<ExamPdfProgress[]>{
 const {batches,defs}=await loadBatches(ids,db);
 const output=new Map(ids.map(examId=>[examId,{examId,totalPapers:0,recognizedPapers:0,scoringCompletePapers:0,totalQuestions:0,recognizedQuestions:0,scoredQuestions:0,pendingPapers:0,waitingScoreQuestions:0,identityPending:0,queued:0,running:0,failed:0,pausedBatches:0,manualWaitingBatches:0,batches:[]} as ExamPdfProgress]));
 if(!batches.length)return [...output.values()];
 const bids=batches.map(b=>b.id),placeholders=bids.map(()=>"?").join(",");
 const papers=await db.all<Row>(`SELECT id,batch_id,identity_status,ownership_confirmed FROM legacy_pdf_papers WHERE batch_id IN (${placeholders})`,...bids);
 const counts:Row[]=[]; // Filter by bound immutable template; stale question rows do not inflate progress.
 for(const [tid,def] of defs){
  const qids=def.questions.filter(q=>q.gradingType==="objective").map(q=>q.questionId);
  const subset=batches.filter(b=>b.template_id===tid).map(b=>b.id);
  if(!qids.length||!subset.length)continue;
  counts.push(...await db.all<Row>(`SELECT r.paper_id,
   SUM(r.recognition_present) recognized,
   SUM(CASE WHEN r.status='confirmed' AND r.score IS NOT NULL THEN 1 ELSE 0 END) scored
   FROM legacy_pdf_results r FORCE INDEX (legacy_objective_progress_read) JOIN legacy_pdf_papers p ON p.id=r.paper_id
   WHERE p.batch_id IN (${subset.map(()=>"?").join(",")}) AND r.question_id IN (${qids.map(()=>"?").join(",")}) GROUP BY r.paper_id`,...subset,...qids));
 }
 const tasks=await db.all<Row>(`SELECT batch_id,status,COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id IN (${placeholders}) AND kind='objective' AND status IN ('queued','running','failed') GROUP BY batch_id,status`,...bids);
 const oldJobs=await db.all<Row>(`SELECT batch_id,status FROM legacy_pdf_jobs WHERE batch_id IN (${placeholders}) AND kind='objective' AND status IN ('queued','running','failed')`,...bids);
 const byBatch=new Map(batches.map(b=>[b.id,b])),byPaper=new Map(counts.map(c=>[c.paper_id,c]));
 for(const b of batches){const out=output.get(Number(b.exam_id))!;out.batches.push({id:b.id,name:b.original_name,mode:b.objective_mode,paused:!!b.objective_paused,requested:!!b.objective_requested});out.pausedBatches+=b.objective_paused?1:0;out.manualWaitingBatches+=b.objective_mode==="manual"&&!b.objective_requested?1:0;}
 for(const p of papers){
  const b=byBatch.get(p.batch_id)!,out=output.get(Number(b.exam_id))!;
  const required=defs.get(b.template_id)?.questions.filter(q=>q.gradingType==="objective").length||0;
  const c=byPaper.get(p.id),recognized=Math.min(required,Number(c?.recognized||0)),scored=Math.min(required,Number(c?.scored||0));
  out.totalPapers++;out.totalQuestions+=required;out.recognizedQuestions+=recognized;out.scoredQuestions+=scored;
  if(recognized===required)out.recognizedPapers++;
  if(scored===required)out.scoringCompletePapers++;
  if(p.identity_status!=="confirmed"||!p.ownership_confirmed)out.identityPending++;
 }
 for(const task of [...tasks,...oldJobs.map((j):Row=>({...j,n:1}))]){
  const b=byBatch.get(task.batch_id);if(b){const o=output.get(Number(b.exam_id))!;o[task.status as "queued"|"running"|"failed"]+=Number(task.n);}
 }
 for(const o of output.values()){o.pendingPapers=o.totalPapers-o.recognizedPapers;o.waitingScoreQuestions=Math.max(0,o.recognizedQuestions-o.scoredQuestions);}
 return [...output.values()];
}
export async function examQuestionSummary(examId:number,options:{page?:number;pageSize?:number;search?:string}={},db:DbAdapter=getMysqlDb()):Promise<ExamQuestionSummary>{
 const page=Math.max(1,Math.floor(options.page||1)),pageSize=Math.max(1,Math.min(100,Math.floor(options.pageSize||50)));
 const {batches,defs}=await loadBatches([examId],db),columns=new Map<string,ExamQuestionColumn>();
 for(const def of defs.values())for(const q of def.questions)columns.set(q.displayNumber,{number:q.displayNumber,kind:q.gradingType,maxScore:q.maxScore});
 const context=await readReviewGroupScoreContext(db,examId);
 const questions=legacyGroupedQuestionColumns([...columns.values()].sort((a,b)=>Number(a.number)-Number(b.number)||a.number.localeCompare(b.number)),context.groups,context.scores);
 const search=String(options.search||"").trim().slice(0,100);
 const filter=search?" AND (u.name LIKE ? OR u.student_number LIKE ? OR CAST(s.serial_no AS CHAR) LIKE ?)":"";
 const args:any[]=[examId,...(search?Array(3).fill("%"+search+"%"):[])];
 const count=await db.get<Row>(`SELECT COUNT(*) n FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id LEFT JOIN users u ON u.id=p.student_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id WHERE b.exam_id=?${filter}`,...args);
 const papers=await db.all<Row>(`SELECT p.id,p.batch_id,p.sheet_no,p.student_id,p.identity_status,p.ownership_confirmed,u.name,u.student_number,s.serial_no serialNumber FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id LEFT JOIN users u ON u.id=p.student_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id WHERE b.exam_id=?${filter} ORDER BY s.serial_no,p.id LIMIT ? OFFSET ?`,...args,pageSize,(page-1)*pageSize);
 const ids=papers.map(p=>p.id),ph=ids.map(()=>"?").join(",");
 const results=ids.length?await db.all<Row>(`SELECT q.paper_id,q.question_id,q.status,q.score FROM legacy_serial_question_scores q JOIN legacy_paper_serials s ON s.paper_id=q.paper_id AND s.exam_id=q.exam_id AND s.serial_no=q.serial_no WHERE q.exam_id=? AND q.kind='objective' AND q.paper_id IN (${ph})`,examId,...ids):[];
 const marks=ids.length?await db.all<Row>(`SELECT q.paper_id,q.question_id,q.status,q.score FROM legacy_serial_question_scores q JOIN legacy_paper_serials s ON s.paper_id=q.paper_id AND s.exam_id=q.exam_id AND s.serial_no=q.serial_no WHERE q.exam_id=? AND q.kind='teacher_score' AND q.paper_id IN (${ph})`,examId,...ids):[];
 const running=await db.all<Row>("SELECT batch_id FROM legacy_pdf_jobs WHERE kind='objective' AND status IN ('queued','running') AND batch_id IN (SELECT id FROM legacy_pdf_batches WHERE exam_id=?)",examId);
 const stageRunning=await db.all<Row>("SELECT batch_id FROM legacy_pdf_stage_jobs WHERE kind='objective' AND status IN ('queued','running') AND batch_id IN (SELECT id FROM legacy_pdf_batches WHERE exam_id=?)",examId);
 const blocked=new Set([...running,...stageRunning].map(j=>j.batch_id)),byBatch=new Map(batches.map(b=>[b.id,b]));
 const index=(rows:Row[])=>{const map=new Map<string,Map<string,Row>>();for(const r of rows){if(!map.has(r.paper_id))map.set(r.paper_id,new Map());map.get(r.paper_id)!.set(r.question_id,r);}return map;};
 const rs=index(results),ms=index(marks);
 const rows=papers.map(p=>{
  const b=byBatch.get(p.batch_id)!,def=defs.get(b.template_id)!;
  const effective=effectiveLegacyPaperScores({examId,paperId:p.id,serialNumber:p.serialNumber,def,results:[...(rs.get(p.id)?.values()||[])],marks:[...(ms.get(p.id)?.values()||[])],groups:context.groups,groupScores:context.scores});
  const identityConfirmed=p.identity_status==="confirmed"&&!!p.ownership_confirmed,reprocessing=blocked.has(p.batch_id);
  const complete=identityConfirmed&&!reprocessing&&effective.scoringComplete;
  return {paperId:p.id,batchName:b.original_name,sheetNo:Number(p.sheet_no),serialNumber:p.serialNumber==null?null:Number(p.serialNumber),studentId:p.student_id==null?null:Number(p.student_id),studentNumber:p.student_number==null?null:String(p.student_number),studentName:p.name||null,identityConfirmed,scores:effective.scores,historicalScores:effective.historicalScores,groupScores:effective.groupScores,historicalQuestionNumbers:effective.historicalQuestionNumbers,objectiveDone:effective.objectiveDone,objectiveRequired:effective.objectiveRequired,subjectiveDone:effective.subjectiveDone,subjectiveRequired:effective.subjectiveRequired,objectiveScore:effective.objectiveComplete?effective.objective:null,subjectiveScore:effective.subjectiveComplete?effective.subjective:null,totalScore:complete?effective.total:null,reprocessing};
 });
 return {questions,total:Number(count?.n||0),page,pageSize,rows};
}

export const readExamPdfProgress=createExamProgressReader(ids=>examPdfProgress(ids));
