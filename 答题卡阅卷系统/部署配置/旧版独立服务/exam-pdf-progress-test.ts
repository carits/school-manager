import assert from "node:assert/strict";
import {examPdfProgress,examQuestionSummary} from "../../源码/server/services/ExamPdfProgressService";
import type {DbAdapter} from "../../源码/server/db";
const def={format:"school-manager-custom-pdf",title:"test",coordinateSystem:"normalized-top-left",pages:[{role:"front",width:210,height:297}],questions:[
 {questionId:"q1",displayNumber:"1",gradingType:"objective",pageRole:"front",maxScore:1,selectionType:"single",options:[{label:"A",rect:{x:.1,y:.1,width:.1,height:.1}}]},
 {questionId:"q46",displayNumber:"46",gradingType:"teacher_score",pageRole:"front",maxScore:2,regions:[{pageRole:"front",rect:{x:.1,y:.2,width:.2,height:.2}}]}]};
const batches=[{id:"b1",exam_id:21,template_id:"t1",original_name:"scan.pdf",objective_mode:"background_auto",objective_paused:0,objective_requested:0},{id:"b2",exam_id:21,template_id:"t1",original_name:"manual.pdf",objective_mode:"manual",objective_paused:1,objective_requested:0}];
const papers=Array.from({length:5},(_,i)=>({id:"p"+(i+1),batch_id:i===4?"b2":"b1",sheet_no:i+1,student_id:i+1,identity_status:i===3?"wait_confirm":"confirmed",ownership_confirmed:1,student_number:"00"+(i+1),name:"test"}));
const results=[
 {paper_id:"p1",question_id:"q1",status:"confirmed",score:0},
 {paper_id:"p2",question_id:"q1",status:"confirmed",score:null},
 {paper_id:"p3",question_id:"q1",status:"wait_confirm",score:1},
 {paper_id:"p4",question_id:"q1",status:"confirmed",score:1},
 {paper_id:"p5",question_id:"q1",status:"confirmed",score:1},
 {paper_id:"p1",question_id:"stale_q99",status:"confirmed",score:99}];
const marks=papers.map(p=>({paper_id:p.id,question_id:"q46",status:p.id==="p3"?"ready":"reviewed",score:p.id==="p2"?0:2}));
let queries=0;
const db={
 async all(sql:string,...args:any[]){
  queries++;
  if(sql.startsWith("SELECT id,exam_id,template_id"))return batches;
  if(sql.startsWith("SELECT id,definition_json"))return [{id:"t1",definition_json:JSON.stringify(def)}];
  if(sql.includes("SUM(CASE")){
   assert(args.includes("q1"));assert(!args.includes("stale_q99"));
   return [{paper_id:"p1",recognized:1,scored:1},{paper_id:"p2",recognized:1,scored:0},{paper_id:"p3",recognized:0,scored:0},{paper_id:"p4",recognized:1,scored:1},{paper_id:"p5",recognized:1,scored:1}];
  }
  if(sql.startsWith("SELECT id,batch_id,identity_status"))return papers;
  if(sql.includes("FROM legacy_pdf_stage_jobs"))return [{batch_id:"b1",status:"queued",n:2},{batch_id:"b1",status:"failed",n:1}];
  if(sql.startsWith("SELECT batch_id,status FROM legacy_pdf_jobs"))return [{batch_id:"b2",status:"running"}];
  if(sql.startsWith("SELECT p.id,p.batch_id,p.sheet_no"))return papers;
  if(sql.includes("FROM legacy_serial_question_scores WHERE kind='objective'"))return results;
  if(sql.includes("FROM legacy_serial_question_scores WHERE kind='teacher_score'"))return marks;
  if(sql.startsWith("SELECT batch_id FROM legacy_pdf_jobs"))return [{batch_id:"b2"}];
  throw Error("Unexpected SQL: "+sql);
 },
 async get(sql:string){queries++;if(sql.startsWith("SELECT COUNT(*)"))return {n:5};throw Error(sql);}
} as unknown as DbAdapter;
const progress=await examPdfProgress([21,22],db);
assert.equal(progress[0].totalPapers,5);assert.equal(progress[0].recognizedPapers,4);
assert.equal(progress[0].scoringCompletePapers,3);assert.equal(progress[0].totalQuestions,5);
assert.equal(progress[0].recognizedQuestions,4);assert.equal(progress[0].scoredQuestions,3);
assert.equal(progress[0].waitingScoreQuestions,1);assert.equal(progress[0].identityPending,1);
assert.equal(progress[0].queued,2);assert.equal(progress[0].running,1);assert.equal(progress[0].failed,1);
assert.equal(progress[0].pausedBatches,1);assert.equal(progress[0].manualWaitingBatches,1);
assert.equal(progress[1].totalPapers,0);assert(queries<=8);
queries=0;
const summary=await examQuestionSummary(21,{},db);
assert.deepEqual(summary.questions.map(q=>q.number),["1","46"]);
assert.equal(summary.rows[0].scores["1"],0);assert.equal(summary.rows[0].studentNumber,"001");assert.equal(summary.rows[0].totalScore,2);
assert.equal(summary.rows[1].scores["1"],null);assert.equal(summary.rows[1].scores["46"],0);assert.equal(summary.rows[1].objectiveScore,null);assert.equal(summary.rows[1].totalScore,null);
assert.equal(summary.rows[2].scores["1"],null);assert.equal(summary.rows[2].scores["46"],null);
assert.equal(summary.rows[3].totalScore,null);assert.equal(summary.rows[4].totalScore,null);assert(summary.rows[4].reprocessing);
assert(!Object.hasOwn(summary.rows[0].scores,"99"));assert(queries<=8);
console.log("Progress: recognized/scored separation, missing keys, queue/pause/manual counts, empty exams, fixed query count verified.");
console.log("Summary: per-question zero, pending, leading zeros, identity and reprocessing gates, stale question exclusion verified.");

const {createExamProgressReader}=await import("../../源码/shared/examProgressReader");
let tick=0,calls=0,finish!: (rows:typeof progress)=>void;
const reader=createExamProgressReader(ids=>{calls++;return new Promise(resolve=>{finish=resolve;});},5000,()=>tick);
const a=reader([21,22]),b=reader([22]);assert.equal(calls,1);finish(progress);await Promise.all([a,b]);
await reader([21]);assert.equal(calls,1);
tick=5001;const c=reader([21]);assert.equal(calls,2);finish([progress[0]]);await c;
let attempts=0;const retry=createExamProgressReader(async()=>{if(++attempts===1)throw Error("temporary");return [progress[0]];});
await assert.rejects(retry([21]));await retry([21]);assert.equal(attempts,2);
console.log("Progress single-flight, list/detail sharing, cache expiry and failure retry verified.");
