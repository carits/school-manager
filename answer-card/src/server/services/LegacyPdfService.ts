import {effectiveLegacyPaperScores,readReviewGroupScoreContext,assertLegacyQuestionNotGrouped,legacyGroupedQuestionColumns} from "./LegacyReviewGroupScoreService";
import {ensureReviewImportSchema,importedCropImage} from "./ReviewImportService";
import {ensureSerialScoreSchema,backfillSerialScores,syncSerialScores} from "./LegacySerialScoreService";
import {assignPaperSerial,assignBatchPaperSerials} from "./LegacyPaperSerialService";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, rm, rename, stat, statfs, readdir, chmod, open } from "node:fs/promises";
import { existsSync,createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import {callLegacyWorker} from "./LegacyPdfWorkerClient";
import {legacyGenerationReadiness} from "../../shared/legacyGenerationReadiness";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { getMysqlDb, type DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { createDefaultCard } from "../../shared/defaultCard";
import {pdfTemplateVersions} from "../../shared/pdfTemplateVersions";
import { normalizePdfTemplate, validatePdfTemplate, objectivePdfScore, type PdfTemplate, type PdfQuestion } from "../../shared/legacyPdf";
import { getVisibleExamIds, canGradeBlock } from "../../apps/answer-card/server/middleware";
import { ensureExamParticipants, isExamParticipant } from "./examParticipants";
import { claimSpecificPaper } from "./ReviewPoolService";
import { submitReviewCropScores } from "./ReviewService";
import { markScoreMutated } from "./examPublishEvents";
import { databaseTimestamp } from "../db/timestamp";
import { recomputeExamRankings } from "./rankingUpdate";
type Row=Record<string,any>;
const require=createRequire(import.meta.url), yauzl=require("yauzl"), archiver=require("archiver"), XLSX=require("xlsx");
const run=promisify(execFile);
const root=path.join(process.env.ANSWER_CARD_DATA_DIR||path.resolve("data/answer-card"),"legacy-pdf");
const workerPath=process.env.LEGACY_PDF_WORKER||path.resolve("resources/legacy-worker.py");
const db=()=>getMysqlDb();
const js=(v:any,f:any=null)=>{try{return typeof v==="string"?JSON.parse(v):v??f;}catch{return f;}};
const uid=()=>randomUUID();
const err=(code:number,message:string)=>Object.assign(new Error(message),{status:code});
export const legacyBlockId=(templateId:string,qid:string)=>createHash("sha256").update(templateId+":"+qid).digest("hex").slice(0,32);
const manager=(req:Request)=>{const u=req.user as any;return !!u&&(Number(u.role_id)===1||u.teacher_role==="grade_leader");};
const manage=(req:Request)=>{if(!manager(req))throw err(403,"仅管理员或学年主任可管理扫描和模板");};
const actor=(req:Request)=>Number(req.user?.id);
const wrap=(fn:(req:Request,res:Response)=>Promise<any>)=>(req:Request,res:Response,next:any)=>{void fn(req,res).catch(next);};
async function audit(tx:DbAdapter,type:string,id:string,action:string,user:number|null,before:any,after:any){
 await tx.run("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json) VALUES(?,?,?,?,?,?)",type,id,action,user,before==null?null:JSON.stringify(before),after==null?null:JSON.stringify(after));
}
async function quota(){
 const mem=await readFile("/proc/meminfo","utf8");const available=Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]||0)*1024;
 const fs=await statfs(root);if(available<800*1024**2||Number(fs.bavail)*Number(fs.bsize)<8*1024**3)throw err(503,"资源保护暂停：内存或磁盘余量不足，请稍后重试");
 let stdout="";for(let attempt=0;attempt<3;attempt++){try{stdout=(await run("du",["-sb",root],{timeout:10000})).stdout;break;}catch(e:any){if(attempt===2||!String(e.stderr).includes("No such file or directory"))throw err(503,"资源保护暂停：暂时无法核对存储空间，将自动重试");}}
 if(Number(stdout.split(/\s/)[0])>24*1024**3)throw err(507,"旧模块扫描文件达到24GiB限额，原件保留，暂停新增处理");
}
// Crop images are a small, regenerable cache. The source-upload storage limit
// must not prevent graders from viewing papers that are already on disk.
async function cropCacheQuota(){
 const mem=await readFile("/proc/meminfo","utf8");
 const available=Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]||0)*1024;
 const fs=await statfs(root);
 if(available<384*1024**2||Number(fs.bavail)*Number(fs.bsize)<1024**3)
  throw err(503,"答卷图片缓存空间不足，请联系管理员清理缓存");
}
let workerBusy=false,workerPause:string|null=null,slow=0,lastProbe=0;
async function protect(){
 await quota();
 const file=process.env.LEGACY_PROTECTED_HEALTH_FILE;
 if(file){const health=js(await readFile(file,"utf8"));if(!health||Date.now()-health.time>90000||health.paused)throw err(503,health?.reason||"资源保护暂停：现有阅卷健康探测不可用");}
}
async function execute(cmd:string,args:string[],timeout=90000){
 await protect();const controller=new AbortController();
 const check=setInterval(()=>{void protect().catch(()=>controller.abort());},5000);check.unref();
 try{return await run(cmd,args,{timeout,maxBuffer:4*1024**2,signal:controller.signal});}finally{clearInterval(check);}
}
async function pdfInfo(file:string){const {stdout}=await execute("pdfinfo",[file]);const n=Number(/Pages:\s+(\d+)/.exec(stdout)?.[1]);if(!n||n>200)throw err(400,"PDF须为1～200页，不能加密");return n;}
async function hashFile(file:string){const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest("hex");}
async function storePdf(file:string){
 const handle=await open(file,"r");const signature=Buffer.alloc(5);try{await handle.read(signature,0,5,0);}finally{await handle.close();}
 if(signature.toString()!=="%PDF-")throw err(400,"文件不是PDF");
 await quota();const hash=await hashFile(file),target=path.join(root,"originals",hash+".pdf");await mkdir(path.dirname(target),{recursive:true});
 if(!existsSync(target)){await copyFile(file,target,2).catch(e=>{if(e.code!=="EEXIST")throw e;});await chmod(target,0o444);}
 if(await hashFile(target)!==hash)throw err(500,"原件摘要校验失败");return {hash,path:target};
}
async function workerRequest(request:Row){return callLegacyWorker(workerPath,request,protect);}
async function renderPage(pdf:string,n:number,directory:string){
 await mkdir(directory,{recursive:true});
 return workerRequest({action:"render",pdf,number:n,output:path.join(directory,"p"+n+".png")});
}
async function executeWorker(input:string,output:string){const result=await workerRequest(js(await readFile(input,"utf8")));await writeFile(output,JSON.stringify(result));return result;}
async function orientTemplateRefs(id:string,refs:Row[],def:PdfTemplate){
 for(let i=0;i<refs.length;i++){const rotation=def.pages[i].viewRotation||0,ref=refs[i],base=ref.basePath||ref.path;if(rotation!==(ref.viewRotation||0)){const directory=path.join(root,"templates",id);await mkdir(directory,{recursive:true});const target=path.join(directory,"p"+(i+1)+"-view-"+rotation+".png");await protect();await sharp(base).rotate(rotation).png().toFile(target);const meta=await sharp(target).metadata();refs[i]={...ref,basePath:base,path:target,viewRotation:rotation,width:meta.width,height:meta.height,widthPt:meta.width!*72/150,heightPt:meta.height!*72/150};}def.pages[i].widthPt=refs[i].widthPt;def.pages[i].heightPt=refs[i].heightPt;}
}
async function template(id:string){const t=await db().get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",id);if(!t)throw err(404,"模板不存在");return t;}
async function batchAccess(req:Request,id:string){
 const b=await db().get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=?",id);if(!b)throw err(404,"扫描批次不存在");
 const visible=await getVisibleExamIds(req.user);if(visible&&!visible.includes(Number(b.exam_id)))throw err(403,"无权访问该考试");
 return b;
}
function definition(t:Row,b?:Row):PdfTemplate {
 const def=normalizePdfTemplate(js(t.definition_json));const keys=js(b?.answer_key_json,{});
 def.questions=def.questions.map(q=>({...q,answer:Object.hasOwn(keys,q.questionId)?keys[q.questionId]:q.answer}));return def;
}

async function examDefinition(t:Row,b:Row,adapter:DbAdapter=db()):Promise<PdfTemplate>{
 const def=definition(t,b),saved=await adapter.get<Row>("SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=?",b.exam_id);
 let keys:Row;
 if(saved)keys=js(saved.answers_json,{});
 else{
  const refs=await adapter.all<Row>("SELECT question_number,answer_text FROM exam_answer_keys WHERE exam_id=?",b.exam_id);keys={};
  for(const q of def.questions.filter(q=>q.gradingType==="objective")){
   if(Object.hasOwn(js(b.answer_key_json,{}),q.questionId))continue;
   const ref=refs.find(r=>String(r.question_number)===String(Number(q.displayNumber)));
   if(!ref)continue;
   const text=String(ref.answer_text).trim().toUpperCase();
   const val=/^[A-H]+$/.test(text)?text.split(""):[];
   keys[q.questionId]=val.length&&new Set(val).size===val.length&&val.every(v=>q.options?.some(o=>o.label===v))&&(q.selectionType==="multiple"||val.length===1)?val:null;
  }
 }
 def.questions=def.questions.map(q=>({...q,answer:Object.hasOwn(keys,q.questionId)?keys[q.questionId]:q.answer}));
 return def;
}
async function examTemplate(examId:number,adapter:DbAdapter=db()){
 const e=await adapter.get<Row>("SELECT * FROM exams WHERE id=?",examId);
 if(!e)throw err(404,"考试不存在");
 const t=await adapter.get<Row>("SELECT * FROM legacy_pdf_templates WHERE card_id=? AND status='published' ORDER BY revision DESC LIMIT 1",e.card_id);
 if(!t)throw err(409,"考试未绑定已发布PDF答题卡");
 return {e,t};
}
async function saveExamKeys(req:Request,examId:number,keys:any,adapter?:DbAdapter){
 manage(req);
 if(!keys||typeof keys!=="object"||Array.isArray(keys))throw err(400,"标准答案格式无效");
 const execute=async(tx:DbAdapter)=>{
  const {e,t}=await examTemplate(examId,tx);
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",examId);
  const def=await examDefinition(t,{exam_id:examId},tx),before=Object.fromEntries(def.questions.filter(q=>q.gradingType==="objective").map(q=>[q.questionId,q.answer]));
  for(const [id,val] of Object.entries(keys)){
   const q=def.questions.find(q=>q.questionId===id&&q.gradingType==="objective");
   if(!q||(val!==null&&(!Array.isArray(val)||!val.length||val.some(v=>!q.options?.some(o=>o.label===v))||new Set(val).size!==val.length||(q.selectionType!=="multiple"&&val.length>1))))throw err(400,"标准答案包含无效题号或选项");
  }
  const merged={...before,...keys};
  if(JSON.stringify(merged)===JSON.stringify(before)&&await tx.get<Row>("SELECT exam_id FROM legacy_pdf_exam_keys WHERE exam_id=?",examId))return {ok:true,unchanged:true};
  await tx.run("INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE answers_json=VALUES(answers_json),updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP",examId,JSON.stringify(merged),actor(req));
  await audit(tx,"exam",String(examId),"set_objective_answer_key",actor(req),before,merged);
  const batches=await tx.all<Row>("SELECT * FROM legacy_pdf_batches WHERE exam_id=? ORDER BY id",examId);
  for(const b of batches){
   const bt=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",b.template_id),effective=await examDefinition(bt!,b,tx);
   const papers=await tx.all<Row>("SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY id FOR UPDATE",b.id);
   for(const p of papers){
    const results=await tx.all<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=?",p.id);
    for(const q of effective.questions.filter(q=>q.gradingType==="objective")){
     const rec=results.find(r=>r.question_id===q.questionId);if(rec?.status!=="confirmed")continue;
     const score=objectivePdfScore(q,js(rec.final_value,[]));
     if(rec.score===score)continue;
     await tx.run("UPDATE legacy_pdf_results SET score=?,version=version+1 WHERE id=?",score,rec.id);
     await audit(tx,"result",rec.id,"exam_key_rescore",actor(req),{score:rec.score},{score});
     await tx.run("UPDATE question_scores SET score=?,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'",score,actor(req),databaseTimestamp(),examId,p.student_id,Number(q.displayNumber));
    }
    await writeTotals(tx,p.id,actor(req));
   }
  }
  await markScoreMutated(tx,examId,actor(req),"answer_edit");
  return {ok:true,unchanged:false};
 };
 return adapter?execute(adapter):db().transactionWithNamedLock("legacy-exam-keys-"+examId,5000,execute);
}
export async function syncLegacyExamReferenceKeys(req:Request,examId:number,refs:Array<{questionNumber:number;answerText:string}>,tx:DbAdapter){
 if(process.env.PROJECTX_LEGACY_ONLY!=="1"||!manager(req))return;
 const e=await tx.get<Row>("SELECT card_id FROM exams WHERE id=?",examId);
 const t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE card_id=? AND status='published' ORDER BY revision DESC LIMIT 1",e?.card_id);
 if(!t)return;
 const keys:Row={},warnings:string[]=[];
 for(const q of definition(t).questions.filter(q=>q.gradingType==="objective")){
  const ref=refs.find(r=>r.questionNumber===Number(q.displayNumber)),text=ref?.answerText.trim().toUpperCase()||"",val=/^[A-H]+$/.test(text)?text.split(""):[];
  const valid=val.length&&new Set(val).size===val.length&&val.every(v=>q.options?.some(o=>o.label===v))&&(q.selectionType==="multiple"||val.length===1);
  keys[q.questionId]=valid?val:null;
  if(!valid)warnings.push("第"+q.displayNumber+"题没有可用于计分的标准选项");
 }
 await saveExamKeys(req,examId,keys,tx);
 return {warnings};
}

async function roster(examId:number,adapter:DbAdapter=db()){
 await ensureExamParticipants(adapter,examId);
 return adapter.all<Row>("SELECT u.id,u.student_number,u.name FROM exam_participants ep JOIN users u ON u.id=ep.student_id WHERE ep.exam_id=? AND u.role_id=3 AND (ep.source='explicit' OR NOT EXISTS(SELECT 1 FROM exam_participants x WHERE x.exam_id=ep.exam_id AND x.source='explicit'))",examId);
}
function identityCandidate(values:Row[],students:Row[]){
 const order=["qr","barcode","omr_digits","student_number_ocr","name_ocr"];
 const allMatches=new Map<number,Row>();for(const v of values){const matched=students.filter(s=>v.method==="name_ocr"?s.name===v.value:String(s.student_number)===String(v.value));if(matched.length===1)allMatches.set(Number(matched[0].id),{...v,studentId:matched[0].id});}if(allMatches.size>1)return {status:"conflict",candidates:Array.from(allMatches.values())};
 for(const method of order){const candidates=values.filter(v=>v.method===method);
 const matches=new Map<number,Row>();for(const v of candidates){const matched=students.filter(s=>method==="name_ocr"?s.name===v.value:String(s.student_number)===String(v.value));if(matched.length===1)matches.set(Number(matched[0].id),{...v,studentId:matched[0].id,name:matched[0].name,studentNumber:matched[0].student_number});}
 if(matches.size===1)return {status:"candidate",...Array.from(matches.values())[0]};
 if(matches.size>1)return {status:"conflict",candidates};}
 return {status:"unrecognized",candidates:values};
}
async function settleObjectiveResults(tx:DbAdapter,b:Row,t:Row,pid:string,user:number){
 const def=await examDefinition(t,b,tx),pages=await tx.all<Row>("SELECT page_role,status FROM legacy_pdf_pages WHERE paper_id=?",pid);
 for(const q of def.questions.filter(q=>q.gradingType==="objective")){
  if(!pages.some(p=>p.page_role===q.pageRole&&p.status==="recognized"))continue;
  const r=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=? FOR UPDATE",pid,q.questionId);
  if(!r||r.final_value!=null||r.status==="confirmed")continue;
  const auto=js(r.auto_value),value=auto?.value;
  if(!["recognized","blank","multiple","ambiguous"].includes(auto?.status)||!Array.isArray(value)||value.some(v=>!q.options?.some(o=>o.label===v))||new Set(value).size!==value.length)continue;
  const score=objectivePdfScore(q,value);
  await tx.run("UPDATE legacy_pdf_results SET final_value=?,score=?,status='confirmed',final_source='auto',version=version+1 WHERE id=?",JSON.stringify(value),score,r.id);
  await audit(tx,"result",r.id,"auto_accept_and_score",user,{value:null,status:r.status,score:r.score},{value,score,source:"recognition",recognitionStatus:auto.status});
 }
}
async function settleExistingObjectiveResults(){
 const batches=await db().all<Row>("SELECT * FROM legacy_pdf_batches WHERE status IN('ready','marking','finished')");
 for(const b of batches){
  const t=await template(b.template_id),papers=await db().all<Row>("SELECT p.id FROM legacy_pdf_papers p WHERE p.batch_id=? AND EXISTS(SELECT 1 FROM legacy_pdf_results r WHERE r.paper_id=p.id AND r.final_value IS NULL AND r.status<>'confirmed' AND r.auto_value IS NOT NULL) ORDER BY p.id",b.id);
  for(const p of papers)await db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
   await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
   await settleObjectiveResults(tx,b,t,p.id,b.created_by);
  });
 }
}

async function migrateObjectiveRecognition(){
 const columns:Record<string,Record<string,string>>={
  legacy_pdf_stage_jobs:{queue_no:"BIGINT NOT NULL AUTO_INCREMENT UNIQUE"},
  legacy_pdf_papers:{subjective_generated:"TINYINT NOT NULL DEFAULT 0"},
  legacy_pdf_results:{final_source:"VARCHAR(24) NULL",recognizer_version:"VARCHAR(80) NULL"},
  legacy_pdf_batches:{objective_mode:"VARCHAR(24) NOT NULL DEFAULT 'background_auto'",objective_paused:"TINYINT NOT NULL DEFAULT 0",objective_requested:"TINYINT NOT NULL DEFAULT 0"},
  legacy_pdf_jobs:{kind:"VARCHAR(24) NOT NULL DEFAULT 'scan'",run_id:"VARCHAR(64) NULL",payload_json:"LONGTEXT NULL",priority:"INT NOT NULL DEFAULT 0"}
 };
 for(const [table,fields] of Object.entries(columns))for(const [name,type] of Object.entries(fields)){
  if(!await db().get<Row>("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",table,name))await db().exec("ALTER TABLE "+table+" ADD COLUMN "+name+" "+type);
 }
 const precision=await db().get<Row>("SELECT DATETIME_PRECISION p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='legacy_pdf_stage_jobs' AND COLUMN_NAME='created_at'");
 if(Number(precision?.p)!==3)await db().exec("ALTER TABLE legacy_pdf_stage_jobs MODIFY created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)");
 const rows=await db().all<Row>("SELECT id FROM legacy_pdf_results WHERE final_source IS NULL AND final_value IS NOT NULL");
 if(!rows.length)return; // Avoid rereading the audit archive after source backfill has completed.
 const ids=new Set(rows.map(r=>r.id)),sources=new Map<string,string>();
 const history=await db().all<Row>("SELECT entity_id,action,before_json,after_json FROM legacy_pdf_audit WHERE entity_type='result' AND action IN('auto_accept_and_score','confirm_or_edit','objective_reprocess') ORDER BY id DESC");
 for(const h of history){if(!ids.has(h.entity_id)||sources.has(h.entity_id))continue;const after=js(h.after_json,{});sources.set(h.entity_id,h.action==="auto_accept_and_score"?"auto":h.action==="objective_reprocess"?after.source||"legacy_unknown":"manual");}
 await db().transaction(async tx=>{for(const r of rows)await tx.run("UPDATE legacy_pdf_results SET final_source=? WHERE id=? AND final_source IS NULL",sources.get(r.id)||"legacy_unknown",r.id);});
}
const OBJECTIVE_VERSION="objective-template-residual-v2.0.0";
async function assertNoObjectiveRun(tx:DbAdapter,bid:string){
 const j=await tx.get<Row>("SELECT status FROM legacy_pdf_jobs WHERE batch_id=? AND kind='objective' AND status IN('queued','running')",bid);
 if(j)throw err(409,"选择题正在重新识别，请完成后再执行此操作");
}
export async function assertLegacyObjectiveIdle(tx:DbAdapter,examId:number){
 if(process.env.PROJECTX_LEGACY_ONLY!=="1")return;
 const j=await tx.get<Row>("SELECT j.batch_id FROM legacy_pdf_jobs j JOIN legacy_pdf_batches b ON b.id=j.batch_id WHERE b.exam_id=? AND j.status IN('queued','running') LIMIT 1",examId);
 if(j||await tx.get<Row>("SELECT j.id FROM legacy_pdf_stage_jobs j JOIN legacy_pdf_batches b ON b.id=j.batch_id WHERE b.exam_id=? AND j.status IN('queued','running') LIMIT 1",examId))throw err(409,"扫描或选择题仍有待处理任务，暂不能发布最终成绩");
}

export async function initLegacyPdf(){
 if(process.env.PROJECTX_LEGACY_ONLY!=="1")return;
 await db().exec("CREATE TABLE IF NOT EXISTS legacy_pdf_exam_keys(exam_id INT PRIMARY KEY,answers_json LONGTEXT NOT NULL,updated_by INT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)");
 await mkdir(root,{recursive:true});await mkdir(path.join(root,"tmp"),{recursive:true});
 const sql=await readFile(path.resolve("resources/legacy-schema.sql"),"utf8");for(const part of sql.split(";").filter(x=>x.trim()))await db().exec(part+";");
 const archiveColumn=await db().get<Row>("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='legacy_pdf_templates' AND COLUMN_NAME='archived_at'");
 if(!archiveColumn)await db().exec("ALTER TABLE legacy_pdf_templates ADD COLUMN archived_at DATETIME NULL");

 await ensureReviewImportSchema();
 await migrateObjectiveRecognition();
 const {ensurePaperSerialSchema,backfillPaperSerials}=await import("./LegacyPaperSerialService");await ensurePaperSerialSchema();await backfillPaperSerials();await ensureSerialScoreSchema();await backfillSerialScores();
 const {ensureExamPdfProgressSchema}=await import("./ExamPdfProgressService");await ensureExamPdfProgressSchema();
 await db().run("UPDATE legacy_pdf_jobs SET status='queued',lease_until=NULL WHERE status='running'");
 await db().run("UPDATE legacy_pdf_pages SET status='pending' WHERE status='processing'");
 await settleExistingObjectiveResults();
 await migrateStageJobs();
 const timer=setInterval(()=>{void work().catch(e=>{workerPause=e.message;console.error("[Legacy PDF]",e.message);});},3000);timer.unref();
}
async function processPage(b:Row,t:Row,p:Row,stageId?:string){
 const def=await examDefinition(t,b),pdef=def.pages.find(x=>x.pageRole===p.page_role);if(!pdef)throw new Error("页面角色无效");
 const refs=js(t.pages_json,[]),ref=refs[def.pages.findIndex(x=>x.pageRole===p.page_role)];
 const started=Date.now(),dir=path.join(root,"batches",b.id);await mkdir(dir,{recursive:true});let raw=p.raw_path,renderMs=0;
 if(!existsSync(raw)){const rendered=await renderPage(b.pdf_path,p.source_page,dir);raw=rendered.path;renderMs=rendered.timings?.renderMs||0;}
 const aligned=path.join(dir,p.id+"_v"+(Number(p.version)+1)+"_aligned.png"),input=path.join(dir,p.id+".request.json"),output=path.join(dir,p.id+".result.json");
 const locator=(await batchQrLocators(b)).find((l:Row)=>l.pageRole===p.page_role&&l.rect);
 const students=await roster(b.exam_id);const paper=await db().get<Row>("SELECT student_id,identity_status FROM legacy_pdf_papers WHERE id=?",p.paper_id);
 await writeFile(input,JSON.stringify({preprocessOnly:true,roster:students,skipIdentity:paper?.identity_status==="confirmed",scan:raw,reference:ref.path,aligned,page:{...pdef,qrLocator:locator},template:def,manualPoints:js(p.manual_json)}));
 await db().run("UPDATE legacy_pdf_pages SET status='processing' WHERE id=?",p.id);
 try{await executeWorker(input,output);}catch(e:any){
  if(!/Unreadable page image/.test(e.message))throw e;
  const rendered=await renderPage(b.pdf_path,p.source_page,dir);raw=rendered.path;renderMs+=rendered.timings?.renderMs||0;
  const request=js(await readFile(input,"utf8"));request.scan=raw;await writeFile(input,JSON.stringify(request));await executeWorker(input,output);
 }
 const result=js(await readFile(output,"utf8"));result.timings={...result.timings,renderMs,pageMs:Date.now()-started};
 const databaseStarted=Date.now();await db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
 await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
 await tx.get<Row>("SELECT id FROM legacy_pdf_papers WHERE id=? FOR UPDATE",p.paper_id);
 const current=await tx.get<Row>("SELECT * FROM legacy_pdf_pages WHERE id=? FOR UPDATE",p.id);
 if(!current||Number(current.version)!==Number(p.version)||current.paper_id!==p.paper_id||current.page_role!==p.page_role)throw err(409,"页面已更新，旧处理结果未提交");
 await tx.run("UPDATE legacy_pdf_pages SET status=?,aligned_path=?,alignment_json=?,recognition_json=?,version=version+1 WHERE id=?",result.alignment.status==="aligned"?"recognized":"wait_alignment",result.alignment.status==="aligned"?aligned:null,JSON.stringify(result.alignment),JSON.stringify(result),p.id);
 await audit(tx,"page",p.id,"recognize",b.created_by,js(current?.recognition_json),result);
 for(const q of result.questions||[]){
 await tx.run("UPDATE legacy_pdf_results SET auto_value=?,confidence=?,recognizer_version=?,version=version+1 WHERE paper_id=? AND question_id=?",JSON.stringify(q),q.confidence,q.algorithmVersion||null,p.paper_id,q.questionId);
 }

 const values=await tx.all<Row>("SELECT recognition_json FROM legacy_pdf_pages WHERE paper_id=?",p.paper_id);
 const candidate=identityCandidate(values.flatMap(v=>js(v.recognition_json,{identities:[]}).identities||[]),students);
 if(paper?.identity_status!=="confirmed")await tx.run("UPDATE legacy_pdf_papers SET auto_identity=?,version=version+1 WHERE id=?",JSON.stringify(candidate),p.paper_id);
 if(stageId)await tx.run("UPDATE legacy_pdf_stage_jobs SET status='done',lease_until=NULL,error=NULL WHERE id=?",stageId);
 });
 console.info("[Legacy timing]",JSON.stringify({batchId:b.id,pageId:p.id,...result.timings,databaseMs:Date.now()-databaseStarted}));
}

async function objectiveInput(b:Row,t:Row,adapter:DbAdapter=db()){
 const pages=await adapter.all<Row>("SELECT id,paper_id,page_role,status,aligned_path,version,alignment_json FROM legacy_pdf_pages WHERE batch_id=? ORDER BY source_page",b.id);
 const def=definition(t),roles=new Set(def.questions.filter(q=>q.gradingType==="objective").map(q=>q.pageRole));
 if(pages.some(p=>p.status!=="recognized"||!p.paper_id||!p.aligned_path))throw err(409,"请先完成页面识别和校正");
 const selected=pages.filter(p=>roles.has(p.page_role));
 if(!selected.length)throw err(409,"模板没有可重新识别的选择题页面");
 const snapshot={batchId:b.id,pdfHash:b.pdf_hash,templateId:t.id,templateHash:t.pdf_hash,definitionHash:createHash("sha256").update(t.definition_json).digest("hex"),pages};
 return {def,selected,snapshot,fingerprint:createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")};
}
async function enqueueObjective(req:Request,b:Row){
 manage(req);await protect();
 return db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
  const current=await tx.get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=? FOR UPDATE",b.id),t=await template(current!.template_id);
  const input=await objectiveInput(current!,t,tx),job=await tx.get<Row>("SELECT * FROM legacy_pdf_jobs WHERE batch_id=? FOR UPDATE",b.id),old=js(job?.payload_json,{});
  if(await tx.get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective' AND status IN('queued','running') LIMIT 1",b.id))throw err(409,"客观题首轮任务仍在处理中，请完成后再重新识别");
  if(job?.kind==="objective"&&["queued","running"].includes(job.status))return {runId:job.run_id,status:job.status,reused:true};
  if(job?.kind==="objective"&&old.fingerprint===input.fingerprint&&old.algorithmVersion===OBJECTIVE_VERSION){
   if(job.status!=="done")await tx.run("UPDATE legacy_pdf_jobs SET status='queued',error=NULL WHERE batch_id=?",b.id);
   return {runId:job.run_id,status:job.status==="done"?"done":"queued",reused:true};
  }
  const runId=uid(),payload={runId,algorithmVersion:OBJECTIVE_VERSION,fingerprint:input.fingerprint,snapshot:input.snapshot,operator:actor(req),completed:{},total:input.selected.length,finished:0,changedAuto:0,preservedManual:0,uncertain:0,createdAt:new Date().toISOString()};
  await tx.run("INSERT INTO legacy_pdf_jobs(batch_id,status,kind,run_id,payload_json) VALUES(?,'queued','objective',?,?) ON DUPLICATE KEY UPDATE status='queued',kind='objective',run_id=VALUES(run_id),payload_json=VALUES(payload_json),attempts=0,lease_until=NULL,error=NULL",b.id,runId,JSON.stringify(payload));
  await audit(tx,"batch",b.id,"queue_objective_reprocess",actor(req),null,{runId,algorithmVersion:OBJECTIVE_VERSION,fingerprint:input.fingerprint});
  return {runId,status:"queued",reused:false};
 });
}
async function objectiveProgress(bid:string){
 const j=await db().get<Row>("SELECT status,error,run_id,payload_json,kind FROM legacy_pdf_jobs WHERE batch_id=?",bid);if(j?.kind!=="objective")return null;
 const p=js(j.payload_json,{});return {runId:j.run_id,status:j.status,error:j.error,algorithmVersion:p.algorithmVersion,total:p.total,finished:p.finished,changedAuto:p.changedAuto,preservedManual:p.preservedManual,uncertain:p.uncertain};
}
async function runObjective(job:Row,b:Row,t:Row){
 const payload=js(job.payload_json,{}),input=await objectiveInput(b,t);
 if(payload.algorithmVersion!==OBJECTIVE_VERSION||payload.fingerprint!==input.fingerprint)throw err(409,"模板或页面已变化，请创建新的重新识别任务");
 if(await hashFile(b.pdf_path)!==b.pdf_hash||await hashFile(t.pdf_path)!==t.pdf_hash)throw err(409,"原件摘要校验失败");
 const refs=js(t.pages_json,[]),dir=path.join(root,"objective-runs",job.run_id);await mkdir(dir,{recursive:true});await quota();
 for(const p of input.selected){
  await protect();const imageHash=await hashFile(p.aligned_path);
  const reference=refs[input.def.pages.findIndex(x=>x.pageRole===p.page_role)].path,refHash=await hashFile(reference);
  const output=path.join(dir,p.id+".result.json"),request=path.join(dir,p.id+".request.json");
  const cached=payload.completed[p.id];
  if(!cached||cached.imageHash!==imageHash||cached.refHash!==refHash||!existsSync(output)){
   await writeFile(request,JSON.stringify({objectiveOnly:true,scan:p.aligned_path,reference,template:input.def,page:input.def.pages.find(x=>x.pageRole===p.page_role)}));
   await executeWorker(request,output);
   const result=js(await readFile(output,"utf8"));
   if(result.alignment?.status!=="aligned"||result.questions?.some((q:Row)=>q.algorithmVersion!==OBJECTIVE_VERSION))throw err(500,"选择题识别器版本或输出无效");
   payload.completed[p.id]={imageHash,refHash,output};
  }
  payload.finished=Object.keys(payload.completed).length;
  await db().run("UPDATE legacy_pdf_jobs SET payload_json=?,lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE batch_id=? AND run_id=?",JSON.stringify(payload),b.id,job.run_id);
  if((await db().get<Row>("SELECT objective_paused FROM legacy_pdf_batches WHERE id=?",b.id))?.objective_paused||await db().get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE status='queued' AND priority>10 LIMIT 1")){
   await db().run("UPDATE legacy_pdf_jobs SET status='queued',lease_until=NULL WHERE batch_id=? AND run_id=?",b.id,job.run_id);return;
  }
 }
 const staged=new Map<string,Row>();
 for(const p of input.selected){
  const cached=payload.completed[p.id],reference=refs[input.def.pages.findIndex(x=>x.pageRole===p.page_role)].path;
  if(await hashFile(p.aligned_path)!==cached.imageHash||await hashFile(reference)!==cached.refHash)throw err(409,"页面图像已变化，未提交新结果");
  const result=js(await readFile(cached.output,"utf8"));staged.set(p.id,result);
 }
 await commitObjective(job,b,t,payload,staged);
}


async function commitObjective(job:Row,b:Row,t:Row,payload:Row,staged:Map<string,Row>){
 await db().transactionWithNamedLock("legacy-batch-"+b.id,10000,async tx=>{
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
  const current=await tx.get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=? FOR UPDATE",b.id),currentTemplate=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=? FOR UPDATE",current!.template_id);
  await tx.all<Row>("SELECT id FROM legacy_pdf_pages WHERE batch_id=? ORDER BY source_page FOR UPDATE",b.id);
  const check=await objectiveInput(current!,currentTemplate!,tx);
  if(check.fingerprint!==payload.fingerprint)throw err(409,"输入已变化，新结果未提交");
  const currentJob=await tx.get<Row>("SELECT run_id,status FROM legacy_pdf_jobs WHERE batch_id=? FOR UPDATE",b.id);
  if(!currentJob||currentJob.run_id!==job.run_id||currentJob.status!=="running")throw err(409,"重新识别任务已变化");
  const effective=await examDefinition(currentTemplate!,current!,tx),papers=await tx.all<Row>("SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY id FOR UPDATE",b.id);
  let scoreChanged=false,changedAuto=0,preservedManual=0,uncertain=0;
  for(const p of check.selected){
   const output=staged.get(p.id)!,expected=effective.questions.filter(q=>q.gradingType==="objective"&&q.pageRole===p.page_role);
   if(output.questions.length!==expected.length||new Set(output.questions.map((q:Row)=>q.questionId)).size!==expected.length)throw err(500,"选择题识别输出缺题或重复");
   for(const q of expected){
    const auto=output.questions.find((x:Row)=>x.questionId===q.questionId),record=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=? FOR UPDATE",p.paper_id,q.questionId);
    if(!record||!auto||!Array.isArray(auto.value)||auto.value.some((v:string)=>!q.options?.some(o=>o.label===v))||new Set(auto.value).size!==auto.value.length)throw err(500,"选择题识别输出无效");
    const before={auto:js(record.auto_value),value:js(record.final_value),score:record.score,status:record.status,source:record.final_source,version:record.version,recognizerVersion:record.recognizer_version};
    const source=record.final_source||(record.final_value==null?"auto":"legacy_unknown"),automatic=source==="auto";
    const value=automatic?auto.value:js(record.final_value),score=automatic?objectivePdfScore(q,value):record.score,status=automatic?"confirmed":record.status;
    if(automatic&&JSON.stringify(before.value)!==JSON.stringify(value))changedAuto++;
    if(!automatic)preservedManual++;
    if(auto.status==="ambiguous")uncertain++;
    scoreChanged=scoreChanged||record.score!==score;
    await tx.run("UPDATE legacy_pdf_results SET auto_value=?,confidence=?,recognizer_version=?,final_value=?,score=?,status=?,final_source=?,version=version+1 WHERE id=?",JSON.stringify(auto),auto.confidence,OBJECTIVE_VERSION,value==null?null:JSON.stringify(value),score,status,source,record.id);
    await audit(tx,"result",record.id,"objective_reprocess",payload.operator,before,{auto,value,score,status,source,runId:job.run_id,algorithmVersion:OBJECTIVE_VERSION,version:Number(record.version)+1});
    const paper=papers.find(x=>x.id===p.paper_id);
    if(automatic&&paper?.student_id)await tx.run("UPDATE question_scores SET score=?,selected_options=?,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'",score,JSON.stringify(value),payload.operator,databaseTimestamp(),b.exam_id,paper.student_id,Number(q.displayNumber));
   }
   const page=await tx.get<Row>("SELECT recognition_json FROM legacy_pdf_pages WHERE id=?",p.id),old=js(page?.recognition_json,{});
   await tx.run("UPDATE legacy_pdf_pages SET recognition_json=? WHERE id=?",JSON.stringify({...old,questions:output.questions,objectiveAlgorithmVersion:OBJECTIVE_VERSION}),p.id);
  }
  for(const p of papers){await tx.run("UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?",p.id);await writeTotals(tx,p.id,payload.operator);}
  if(scoreChanged)await markScoreMutated(tx,b.exam_id,payload.operator,"answer_edit");
  Object.assign(payload,{changedAuto,preservedManual,uncertain,committedAt:new Date().toISOString()});
  await audit(tx,"batch",b.id,"commit_objective_reprocess",payload.operator,{algorithmVersion:"previous"},{runId:job.run_id,algorithmVersion:OBJECTIVE_VERSION,changedAuto,preservedManual,uncertain,scoreChanged});
  await tx.run("UPDATE legacy_pdf_jobs SET status='done',payload_json=?,error=NULL,lease_until=NULL WHERE batch_id=? AND run_id=?",JSON.stringify(payload),b.id,job.run_id);
 });
 const pending=await db().get<Row>("SELECT COUNT(*) n FROM student_scores WHERE exam_id=? AND total_score IS NULL",b.exam_id);
 if(!Number(pending?.n))await recomputeExamRankings(db(),b.exam_id);
}

const PREPROCESS_VERSION="preprocess-identity-v1.0.0";
async function queuePreprocess(tx:DbAdapter,b:Row,t:Row,page:Row,priority=200){
 const hash=createHash("sha256").update(JSON.stringify({batch:b.id,exam:b.exam_id,page:page.id,version:page.version,role:page.page_role,paper:page.paper_id,manual:page.manual_json,pdf:b.pdf_hash,template:t.id,templateHash:t.pdf_hash,algorithm:PREPROCESS_VERSION})).digest("hex");
 await tx.run("INSERT IGNORE INTO legacy_pdf_stage_jobs(id,batch_id,paper_id,page_id,kind,input_hash,algorithm_version,priority,payload_json,created_by) VALUES(?,?,?,?,'preprocess',?,?,?,?,?)",uid(),b.id,page.paper_id,page.id,hash,PREPROCESS_VERSION,priority,JSON.stringify({pageVersion:page.version}),b.created_by);
 await tx.run("UPDATE legacy_pdf_stage_jobs SET status='queued',error=NULL WHERE kind='preprocess' AND input_hash=? AND status IN('cancelled','failed')",hash);
 await tx.run("UPDATE legacy_pdf_stage_jobs SET status='cancelled',lease_until=NULL WHERE kind='preprocess' AND page_id=? AND input_hash<>? AND status IN('queued','failed')",page.id,hash);
}
async function paperObjectiveInput(tx:DbAdapter,b:Row,t:Row,pid:string){
 const paper=await tx.get<Row>("SELECT id FROM legacy_pdf_papers WHERE id=? AND batch_id=?",pid,b.id);
 const def=definition(t),roles=new Set(def.questions.filter(q=>q.gradingType==="objective").map(q=>q.pageRole));
 const pages=(await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=? ORDER BY source_page",pid)).filter(p=>roles.has(p.page_role));
 if(!paper||[...roles].some(role=>pages.filter(p=>p.page_role===role&&p.status==="recognized"&&p.aligned_path).length!==1))return null;
 const refs=js(t.pages_json,[]),images=[];
 for(const p of pages)images.push({id:p.id,version:p.version,role:p.page_role,aligned:p.aligned_path,imageHash:await hashFile(p.aligned_path),referenceHash:await hashFile(refs[def.pages.findIndex(x=>x.pageRole===p.page_role)].path)});
 // Keep recognition tied to the source sheet and aligned pages, never to identity.
 const snapshot={examId:b.exam_id,paperId:pid,templateId:t.id,templateHash:t.pdf_hash,definitionHash:createHash("sha256").update(t.definition_json).digest("hex"),pdfHash:b.pdf_hash,images};
 return {snapshot,pages,def,fingerprint:createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")};
}
async function queuePaperObjective(tx:DbAdapter,b:Row,t:Row,pid:string,force=false){
 const controls=await tx.get<Row>("SELECT objective_mode,objective_requested FROM legacy_pdf_batches WHERE id=?",b.id);
 if(!force&&controls?.objective_mode==="manual"&&!controls.objective_requested)return null;
 const questions=definition(t).questions.filter(q=>q.gradingType==="objective");if(!questions.length)return null;
 const results=await tx.all<Row>("SELECT question_id,auto_value,final_value FROM legacy_pdf_results WHERE paper_id=?",pid);
 if(questions.every(q=>results.some(r=>r.question_id===q.questionId&&r.auto_value!=null)))return null;
 const input=await paperObjectiveInput(tx,b,t,pid);if(!input)return null;
 const id=uid(),payload={snapshot:input.snapshot,completed:{},operator:b.created_by,total:input.pages.length,finished:0};
 await tx.run("INSERT IGNORE INTO legacy_pdf_stage_jobs(id,batch_id,paper_id,kind,input_hash,algorithm_version,priority,payload_json,created_by) VALUES(?,?,?,'objective',?,?,10,?,?)",id,b.id,pid,input.fingerprint,OBJECTIVE_VERSION,JSON.stringify(payload),b.created_by);
 await tx.run("UPDATE legacy_pdf_stage_jobs SET status='cancelled',lease_until=NULL,error='客观题输入已更新' WHERE paper_id=? AND kind='objective' AND input_hash<>? AND status IN('queued','failed')",pid,input.fingerprint);
 return tx.get<Row>("SELECT id,status FROM legacy_pdf_stage_jobs WHERE kind='objective' AND input_hash=?",input.fingerprint);
}
async function migrateStageJobs(){
 const recovered=await db().all<Row>("SELECT DISTINCT p.id FROM legacy_pdf_pages p JOIN legacy_pdf_stage_jobs j ON j.page_id=p.id WHERE p.status='failed' AND j.status='failed' AND j.error='Unreadable page image' AND NOT EXISTS(SELECT 1 FROM legacy_pdf_marks m WHERE m.paper_id=p.paper_id)");
 for(const p of recovered)await db().run("UPDATE legacy_pdf_pages SET status='pending',version=version+1 WHERE id=? AND status='failed'",p.id);
 await db().run("UPDATE legacy_pdf_stage_jobs j JOIN legacy_pdf_pages p ON p.id=j.page_id SET j.status='done',j.lease_until=NULL WHERE j.kind='preprocess' AND j.status='failed' AND p.status='recognized'");
 await db().run("UPDATE legacy_pdf_stage_jobs SET status='queued',lease_until=NULL WHERE status='running'");
 await db().run("UPDATE legacy_pdf_papers p SET subjective_generated=1 WHERE subjective_generated=0 AND EXISTS(SELECT 1 FROM legacy_pdf_marks m WHERE m.paper_id=p.id)");
 const batches=await db().all<Row>("SELECT * FROM legacy_pdf_batches ORDER BY created_at");
 for(const b of batches){
  const t=await template(b.template_id),old=await db().get<Row>("SELECT * FROM legacy_pdf_jobs WHERE batch_id=?",b.id);
  const urgent=js(old?.payload_json,{}).urgentPapers||[];
  const pages=await db().all<Row>("SELECT * FROM legacy_pdf_pages WHERE batch_id=? AND status IN('pending','processing')",b.id);
  await db().transaction(async tx=>{
   for(const p of pages)await queuePreprocess(tx,b,t,p,urgent.includes(p.paper_id)?300:200);
   if(old?.kind!=="objective")await tx.run("UPDATE legacy_pdf_jobs SET status=?,lease_until=NULL WHERE batch_id=?",pages.length?"staged":old?.status||"done",b.id);
  });
  // Existing persistent jobs already survive restarts; only backfill missing jobs.
  const papers=await db().all<Row>("SELECT p.id FROM legacy_pdf_papers p WHERE p.batch_id=? AND EXISTS(SELECT 1 FROM legacy_pdf_results r WHERE r.paper_id=p.id AND r.auto_value IS NULL) AND NOT EXISTS(SELECT 1 FROM legacy_pdf_stage_jobs j WHERE j.paper_id=p.id AND j.kind='objective' AND j.status IN('queued','running'))",b.id);
  for(const paper of papers)await db().transaction(async tx=>{await queuePaperObjective(tx,b,t,paper.id);});
 }
}
async function stageProgress(b:Row){
 const jobs=await db().all<Row>("SELECT kind,status,COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=? GROUP BY kind,status",b.id);
 const ps=await papersDetail(b),t=await template(b.template_id),ready=legacyGenerationReadiness(definition(t),ps);
 const marks=await db().get<Row>("SELECT COUNT(DISTINCT m.paper_id) n FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=?",b.id);
 const pages=await db().get<Row>("SELECT COUNT(*) total,SUM(status='recognized') aligned,SUM(status='wait_alignment') exceptional FROM legacy_pdf_pages WHERE batch_id=?",b.id);
 const completed=ps.filter(p=>definition(t).questions.filter(q=>q.gradingType==="objective").every(q=>p.results.some((r:Row)=>r.question_id===q.questionId&&r.auto_value!=null))).length;
 const errors=await db().all<Row>("SELECT id,kind,page_id,paper_id,error FROM legacy_pdf_stage_jobs WHERE batch_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 20",b.id);
 return {errors,objectiveMode:b.objective_mode||"background_auto",objectivePaused:!!b.objective_paused,stages:{pages,identity:{confirmed:ps.filter(p=>p.identity_status==="confirmed"&&p.ownership_confirmed).length,total:ps.length},subjective:{ready:ready.readyCount,generated:Number(marks?.n||0),total:ps.length},objective:{completed,total:ps.length,tasks:jobs.filter(j=>j.kind==="objective")}},tasks:jobs};
}
async function refreshScanProjection(b:Row){
 const pending=await db().get<Row>("SELECT COUNT(*) n FROM legacy_pdf_pages WHERE batch_id=? AND status IN('pending','processing')",b.id);
 const marks=await db().get<Row>("SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? LIMIT 1",b.id);
 await db().run("UPDATE legacy_pdf_batches SET finished=(SELECT COUNT(*) FROM legacy_pdf_pages WHERE batch_id=? AND status NOT IN('pending','processing')),status=?,error=NULL WHERE id=?",b.id,marks?"marking":Number(pending?.n)?"queued":"ready",b.id);
 await db().run("UPDATE legacy_pdf_jobs SET status=?,lease_until=NULL WHERE batch_id=? AND kind='scan'",Number(pending?.n)?"staged":"done",b.id);
}
async function runPaperObjective(job:Row,b:Row,t:Row){
 const input=await paperObjectiveInput(db(),b,t,job.paper_id);
 if(!input||input.fingerprint!==job.input_hash)throw err(409,"选择题输入已变化，旧任务未提交");
 const payload=js(job.payload_json,{}),refs=js(t.pages_json,[]),dir=path.join(root,"stage-runs",job.id);await mkdir(dir,{recursive:true});
 const page=input.pages.find(p=>!payload.completed[p.id]);
 if(page){
  const output=path.join(dir,page.id+".json"),reference=refs[input.def.pages.findIndex(x=>x.pageRole===page.page_role)].path;
  const result=await workerRequest({objectiveOnly:true,scan:page.aligned_path,reference,template:input.def,page:input.def.pages.find(x=>x.pageRole===page.page_role)});
  await writeFile(output,JSON.stringify(result));payload.completed[page.id]={output};payload.finished=Object.keys(payload.completed).length;
  await db().run("UPDATE legacy_pdf_stage_jobs SET payload_json=? WHERE id=?",JSON.stringify(payload),job.id);
 }
 if(payload.finished<input.pages.length){await db().run("UPDATE legacy_pdf_stage_jobs SET status='queued',lease_until=NULL WHERE id=?",job.id);return;}
 await db().transactionWithNamedLock("legacy-batch-"+b.id,10000,async tx=>{
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
  const paper=await tx.get<Row>("SELECT student_id,identity_status,ownership_confirmed FROM legacy_pdf_papers WHERE id=? FOR UPDATE",job.paper_id);
  await tx.all<Row>("SELECT id FROM legacy_pdf_pages WHERE paper_id=? FOR UPDATE",job.paper_id);
  const check=await paperObjectiveInput(tx,b,t,job.paper_id);if(!check||check.fingerprint!==job.input_hash)throw err(409,"页面或身份已变化，选择题结果未提交");
  const def=await examDefinition(t,b,tx);let changed=false;
  for(const p of check.pages){
   const result=js(await readFile(payload.completed[p.id].output,"utf8")),expected=def.questions.filter(q=>q.gradingType==="objective"&&q.pageRole===p.page_role);
   if(result.questions.length!==expected.length||new Set(result.questions.map((q:Row)=>q.questionId)).size!==expected.length)throw err(500,"选择题输出缺题或重复");
   for(const q of expected){
    const auto=result.questions.find((x:Row)=>x.questionId===q.questionId),r=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=? FOR UPDATE",job.paper_id,q.questionId);
    if(!r||auto?.algorithmVersion!==OBJECTIVE_VERSION||!Array.isArray(auto.value)||auto.value.some((v:string)=>!q.options?.some(o=>o.label===v))||new Set(auto.value).size!==auto.value.length)throw err(500,"选择题输出无效");
    const source=r.final_source||(r.final_value==null?"auto":"legacy_unknown"),value=source==="auto"?auto.value:js(r.final_value),score=Array.isArray(value)?objectivePdfScore(q,value):null;
    changed=changed||r.score!==score;
    await tx.run("UPDATE legacy_pdf_results SET auto_value=?,confidence=?,recognizer_version=?,final_value=?,score=?,status=?,final_source=?,version=version+1 WHERE id=?",JSON.stringify(auto),auto.confidence,OBJECTIVE_VERSION,value==null?null:JSON.stringify(value),score,value==null?"wait_confirm":"confirmed",source,r.id);
    await audit(tx,"result",r.id,"objective_stage",job.created_by,{value:js(r.final_value),score:r.score,source:r.final_source},{auto,value,score,source,taskId:job.id,algorithmVersion:OBJECTIVE_VERSION});
    const student=paper?.identity_status==="confirmed"&&paper.ownership_confirmed?paper.student_id:null;
    if(student&&value!=null&&score!=null)await tx.run("INSERT INTO question_scores(exam_id,student_id,question_number,block_id,score,max_score,score_type,selected_options,modified_by,modified_at) VALUES(?,?,?,?,?,?,'objective',?,?,?) ON DUPLICATE KEY UPDATE score=VALUES(score),selected_options=VALUES(selected_options),modified_by=VALUES(modified_by),modified_at=VALUES(modified_at)",b.exam_id,student,Number(q.displayNumber),q.blockId||legacyBlockId(t.id,q.questionId),score,q.maxScore,JSON.stringify(value),job.created_by,databaseTimestamp());
   }
   const current=await tx.get<Row>("SELECT recognition_json FROM legacy_pdf_pages WHERE id=?",p.id);
   await tx.run("UPDATE legacy_pdf_pages SET recognition_json=? WHERE id=?",JSON.stringify({...js(current?.recognition_json,{}),questions:result.questions,objectiveAlgorithmVersion:OBJECTIVE_VERSION}),p.id);
  }
  await writeTotals(tx,job.paper_id,job.created_by);
  if(changed)await markScoreMutated(tx,b.exam_id,job.created_by,"answer_edit");
  await tx.run("UPDATE legacy_pdf_stage_jobs SET status='done',lease_until=NULL,error=NULL WHERE id=?",job.id);
  await tx.run("UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?",job.paper_id);
  await audit(tx,"paper",job.paper_id,"commit_objective_stage",job.created_by,null,{taskId:job.id,algorithmVersion:OBJECTIVE_VERSION});
 });
 const pending=await db().get<Row>("SELECT COUNT(*) n FROM student_scores WHERE exam_id=? AND total_score IS NULL",b.exam_id);
 if(!Number(pending?.n))await recomputeExamRankings(db(),b.exam_id).catch(()=>{});
}
async function work(){
 if(workerBusy)return;workerBusy=true;let again=false,chosen:Row|null=null;
 try{
  await protect();workerPause=null;
  chosen=await db().transactionWithNamedLock("legacy-pdf-job",1000,async tx=>{
   const stage=await tx.get<Row>("SELECT j.* FROM legacy_pdf_stage_jobs j JOIN legacy_pdf_batches b ON b.id=j.batch_id WHERE j.status='queued' AND (j.kind='preprocess' OR b.objective_paused=0) ORDER BY j.priority DESC,j.created_at,j.queue_no LIMIT 1");
   const legacy=await tx.get<Row>("SELECT j.* FROM legacy_pdf_jobs j JOIN legacy_pdf_batches b ON b.id=j.batch_id WHERE j.kind='objective' AND j.status='queued' AND b.objective_paused=0 ORDER BY j.updated_at LIMIT 1");
   if(stage&&(!legacy||stage.priority>10||(stage.priority===10&&new Date(stage.created_at).getTime()<new Date(js(legacy.payload_json,{}).createdAt||legacy.updated_at).getTime()))){
    if(!await tx.get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE id=? AND status='queued' FOR UPDATE",stage.id))return null;
    await tx.run("UPDATE legacy_pdf_stage_jobs SET status='running',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE id=?",stage.id);return {...stage,stage:true};
   }
   if(legacy){if(!await tx.get<Row>("SELECT batch_id FROM legacy_pdf_jobs WHERE batch_id=? AND status='queued' FOR UPDATE",legacy.batch_id))return null;await tx.run("UPDATE legacy_pdf_jobs SET status='running',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE batch_id=?",legacy.batch_id);return {...legacy,stage:false};}
   if(stage){if(!await tx.get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE id=? AND status='queued' FOR UPDATE",stage.id))return null;await tx.run("UPDATE legacy_pdf_stage_jobs SET status='running',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE id=?",stage.id);return {...stage,stage:true};}
   return null;
  });
  if(!chosen)return;const job=chosen,b=await db().get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=?",job.batch_id),t=await template(b!.template_id);
  if(!job.stage){await runObjective(job,b!,t);again=true;return;}
  if(job.kind==="preprocess"){
   const p=await db().get<Row>("SELECT * FROM legacy_pdf_pages WHERE id=?",job.page_id);
   if(!p||Number(p.version)!==Number(js(job.payload_json).pageVersion))throw err(409,"页面版本已变化，旧任务取消");
   if(["pending","processing"].includes(p.status))await processPage(b!,t,p,job.id);
   await db().run("UPDATE legacy_pdf_stage_jobs SET status='done',lease_until=NULL,error=NULL WHERE id=?",job.id);
   await refreshScanProjection(b!);
   await db().transaction(async tx=>{await queuePaperObjective(tx,b!,t,p.paper_id);});
  }else await runPaperObjective(job,b!,t);
  again=true;
 }catch(e:any){
  const resource=e.status===503||e.status===507||e.name==="AbortError";workerPause=resource?e.message:null;
  if(chosen?.stage){
   await db().run("UPDATE legacy_pdf_stage_jobs SET status=?,error=?,lease_until=NULL WHERE id=? AND status='running'",resource?"queued":e.status===409?"cancelled":"failed",e.message,chosen.id);
   if(chosen.kind==="preprocess")await db().run("UPDATE legacy_pdf_pages SET status=? WHERE id=? AND version=? AND status IN('pending','processing')",resource?"pending":"failed",chosen.page_id,Number(js(chosen.payload_json).pageVersion));
  }else if(chosen)await db().run("UPDATE legacy_pdf_jobs SET status=?,error=?,lease_until=NULL WHERE batch_id=? AND run_id=?",resource?"queued":"failed",e.message,chosen.batch_id,chosen.run_id);
  if(!resource){console.error("[Legacy stage]",e.message);again=true;}
 }finally{workerBusy=false;if(again){const next=setTimeout(()=>{void work().catch(e=>console.error("[Legacy PDF]",e.message));},100);next.unref();}}
}
export async function createLegacyBatch(req:Request,file:{path:string;originalname:string},templateId:string,examId:number){
 manage(req);const t=await template(templateId);if(t.status!=="published"||t.archived_at)throw err(409,"请选择未归档的已发布答题卡");
 const visible=await getVisibleExamIds(req.user);if(visible&&!visible.includes(examId))throw err(403,"无权管理该考试");
 const exam=await db().get<Row>("SELECT * FROM exams WHERE id=?",examId);if(!exam||exam.card_id!==t.card_id)throw err(400,"请选择关联该模板版本的考试");
 const pdf=await storePdf(file.path),existing=await db().get<Row>("SELECT * FROM legacy_pdf_batches WHERE exam_id=? AND template_id=? AND pdf_hash=?",examId,t.id,pdf.hash);
 if(existing)return db().transaction(async tx=>{await assignBatchPaperSerials(tx,examId,existing.id,actor(req));return {jobId:existing.id,id:existing.id,status:existing.status,reused:true};});
 const n=await pdfInfo(pdf.path),def=definition(t),id=uid();
 return db().transactionWithNamedLock("legacy-upload-"+createHash("sha256").update(examId+":"+t.id+":"+pdf.hash).digest("hex").slice(0,24),5000,async tx=>{
 await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",examId);
 const duplicate=await tx.get<Row>("SELECT * FROM legacy_pdf_batches WHERE exam_id=? AND template_id=? AND pdf_hash=?",examId,t.id,pdf.hash);if(duplicate){await assignBatchPaperSerials(tx,examId,duplicate.id,actor(req));return {jobId:duplicate.id,id:duplicate.id,status:duplicate.status,reused:true};}
 await tx.run("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,total,created_by) VALUES(?,?,?,?,?,?,?,?)",id,examId,t.id,pdf.hash,pdf.path,file.originalname.slice(0,255),n,actor(req));
 for(let i=0;i<n;i++){const sheet=Math.floor(i/def.pages.length)+1;let paper=await tx.get<Row>("SELECT id FROM legacy_pdf_papers WHERE batch_id=? AND sheet_no=?",id,sheet);if(!paper){paper={id:uid()};await tx.run("INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no) VALUES(?,?,?)",paper.id,id,sheet);for(const q of def.questions.filter(q=>q.gradingType==="objective"))await tx.run("INSERT INTO legacy_pdf_results(id,paper_id,question_id) VALUES(?,?,?)",uid(),paper.id,q.questionId);}
 await tx.run("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path) VALUES(?,?,?,?,?,?)",uid(),id,paper.id,i+1,def.pages[i%def.pages.length].pageRole,path.join(root,"batches",id,"p"+(i+1)+".png"));}
 await assignBatchPaperSerials(tx,examId,id,actor(req));
 await tx.run("INSERT INTO legacy_pdf_batch_locators(batch_id,settings_json) VALUES(?,?)",id,JSON.stringify(await qrLocators(t.id,tx)));
 await tx.run("INSERT INTO legacy_pdf_jobs(batch_id) VALUES(?)",id);
 const created=await tx.get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=?",id);for(const page of await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE batch_id=?",id))await queuePreprocess(tx,created!,t,page);await audit(tx,"batch",id,"upload",actor(req),null,{examId,templateId:t.id,hash:pdf.hash,pages:n});
 return {jobId:id,id,status:"queued",reused:false};
 });
}
async function extractZip(file:string){
 const out:Record<string,Buffer>={};await new Promise<void>((resolve,reject)=>{
 yauzl.open(file,{lazyEntries:true,validateEntrySizes:true},(e:any,z:any)=>{if(e)return reject(e);z.on("error",reject);z.on("end",resolve);z.on("entry",(ent:any)=>{
 if(!["answer_card.pdf","template.json"].includes(ent.fileName))return z.readEntry();
 if(out[ent.fileName]||ent.uncompressedSize>(ent.fileName==="template.json"?2*1024**2:256*1024**2)){z.close();return reject(err(400,"模板ZIP文件重复或过大"));}
 z.openReadStream(ent,(e:any,stream:any)=>{if(e)return reject(e);const chunks:Buffer[]=[];let bytes=0;stream.on("error",reject);stream.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024**2){stream.destroy();reject(err(400,"解压大小超限"));}else chunks.push(chunk);});stream.on("end",()=>{out[ent.fileName]=Buffer.concat(chunks);z.readEntry();});});
 });z.readEntry();});
 });if(!out["answer_card.pdf"]||!out["template.json"])throw err(400,"ZIP根目录须包含answer_card.pdf和template.json");return out;
}
const upload=multer({dest:path.join(root,"tmp"),limits:{fileSize:256*1024**2,files:1,fields:12}});
async function uploadTemplate(req:Request){
 manage(req);if(!req.file)throw err(400,"请选择PDF或模板ZIP");
 let source=req.file.path,config:any=null;
 try{
 if(/\.zip$/i.test(req.file.originalname)){const zip=await extractZip(source);config=JSON.parse(zip["template.json"].toString("utf8"));source=path.join(root,"tmp",uid()+".pdf");await writeFile(source,zip["answer_card.pdf"]);}
 else if(req.body.definition)config=JSON.parse(req.body.definition);
 const pdf=await storePdf(source),n=await pdfInfo(pdf.path);if(n>10)throw err(400,"模板最多10页");
 const id=uid(),refs:Row[]=[];for(let i=1;i<=n;i++)refs.push(await renderPage(pdf.path,i,path.join(root,"templates",id)));
 const def=config?normalizePdfTemplate(config):normalizePdfTemplate({title:req.body.title||req.file.originalname,pages:refs.map((p,i)=>({pageRole:"page"+(i+1),sourcePdfPage:i+1,widthPt:p.widthPt,heightPt:p.heightPt,anchorCandidates:[]})),identities:[],questions:[]});
 if(def.pages.length!==n)throw err(400,"配置页数与模板PDF不一致");def.pages=def.pages.map((p,i)=>({...p,widthPt:refs[i].widthPt,heightPt:refs[i].heightPt,sourcePdfPage:i+1}));
 const errors=validatePdfTemplate(def);if(errors.length)throw err(400,errors.join("；"));await orientTemplateRefs(id,refs,def);
 await db().transaction(async tx=>{await tx.run("INSERT INTO legacy_pdf_templates(id,family_id,revision,title,definition_json,pdf_hash,pdf_path,pages_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)",id,id,1,def.title,JSON.stringify(def),pdf.hash,pdf.path,JSON.stringify(refs),actor(req));await audit(tx,"template",id,"create",actor(req),null,def);});
 return {id,status:"draft"};
 }finally{await rm(req.file.path,{force:true});if(source!==req.file.path)await rm(source,{force:true});}
}
async function publishTemplate(req:Request,id:string){
 manage(req);return db().transactionWithNamedLock("legacy-template-"+id,2000,async tx=>{
 const t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=? FOR UPDATE",id);if(!t)throw err(404,"模板不存在");if(t.status==="published")return {id,cardId:t.card_id,reused:true};
 const def=definition(t),errors=validatePdfTemplate(def,true);if(errors.length)throw err(400,errors.join("；"));
 const cardId="lp"+createHash("sha256").update(id).digest("hex").slice(0,16),card=createDefaultCard(cardId,def.subject||"语文",def.pages[0].widthPt>900?"A3":"A4");
 card.title=def.title+" · v"+t.revision;card.sided=def.pages.length>1?"double":"single";card.studentInfo.studentNumberDigits=def.identities.find(f=>f.fieldType==="omr_digits")?.length||6;
 card.bodyBlocks=def.questions.map(q=>q.gradingType==="objective"?{id:legacyBlockId(id,q.questionId),type:"objective",title:"第"+q.displayNumber+"题",questionStart:Number(q.displayNumber),questionCount:1,optionCount:q.options?.length||4,mode:q.selectionType==="multiple"?"multiple":"single",scorePerQuestion:q.maxScore,density:"compact",answerKey:q.answer?{[Number(q.displayNumber)]:q.answer}:undefined}:{id:legacyBlockId(id,q.questionId),type:"subjective",title:"第"+q.displayNumber+"题",questions:[{id:uid(),number:Number(q.displayNumber),score:q.maxScore,style:"plain_subjective",kind:"plain_box",minHeightMm:20}]}) as any;
 const repo=new CardRepository(tx);await repo.createCard(card,actor(req));await repo.updateCardInTx(card,tx);
 await tx.run("UPDATE legacy_pdf_templates SET status='published',card_id=? WHERE id=?",cardId,id);await audit(tx,"template",id,"publish",actor(req),{status:t.status},{status:"published",cardId,definition:def});return {id,cardId,reused:false};
 });
}
export async function visibleLegacyPdfCards<T extends {id:string}>(cards:T[]):Promise<T[]>{
 if(process.env.PROJECTX_LEGACY_ONLY!=="1")return cards;
 const templates=await db().all<Row>("SELECT id,family_id,revision,status,card_id,archived_at FROM legacy_pdf_templates WHERE family_id NOT LIKE 'native:%'");
 const managed=new Set(templates.map(t=>t.card_id).filter(Boolean)),visible=new Set(pdfTemplateVersions(templates as Array<Row&{id:string;revision:number;status:string}>).current.map(t=>t.card_id).filter(Boolean));
 return cards.filter(c=>!managed.has(c.id)||visible.has(c.id));
}
async function qrLocators(templateId:string,adapter:DbAdapter=db()){
 const rows=await adapter.all<Row>("SELECT * FROM legacy_pdf_qr_locators WHERE template_id=? ORDER BY page_role",templateId);
 return rows.map(r=>({pageRole:r.page_role,rect:js(r.rect_json),revision:Number(r.revision)}));
}
async function batchQrLocators(b:Row){
 return db().transaction(async tx=>{
  const existing=await tx.get<Row>("SELECT settings_json FROM legacy_pdf_batch_locators WHERE batch_id=?",b.id);
  if(existing)return js(existing.settings_json,[]);
  const settings=await qrLocators(b.template_id,tx);
  await tx.run("INSERT IGNORE INTO legacy_pdf_batch_locators(batch_id,settings_json) VALUES(?,?)",b.id,JSON.stringify(settings));
  const stored=await tx.get<Row>("SELECT settings_json FROM legacy_pdf_batch_locators WHERE batch_id=?",b.id);
  return js(stored!.settings_json,[]);
 });
}
async function saveQrLocator(req:Request,id:string){
 manage(req);const t=await template(id),def=definition(t),role=String(req.body.pageRole||""),index=def.pages.findIndex(p=>p.pageRole===role);
 if(index<0)throw err(400,"页面角色无效");
 const r=req.body.rect;
 if(r!=null&&(!["x","y","width","height"].every(k=>typeof r[k]==="number"&&Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1||r.y+r.height>1))throw err(400,"请在页面内框选完整二维码");
 if(r!=null){
  const key=uid(),input=path.join(root,"tmp",key+".request.json"),output=path.join(root,"tmp",key+".result.json");
  try{
   await writeFile(input,JSON.stringify({detectLocator:true,reference:js(t.pages_json)[index].path,rect:r}));
   await executeWorker(input,output);
   const result=js(await readFile(output,"utf8"));if(!result?.points)throw err(400,"框选区域未找到二维码，请包含完整二维码和周围空白");
  }finally{await rm(input,{force:true});await rm(output,{force:true});}
 }
 return db().transactionWithNamedLock("legacy-template-qr-"+id,5000,async tx=>{
  const old=await tx.get<Row>("SELECT * FROM legacy_pdf_qr_locators WHERE template_id=? AND page_role=? FOR UPDATE",id,role);
  if(Number(req.body.expectedRevision??0)!==Number(old?.revision||0))throw err(409,"二维码辅助定位已更新，请重新加载");
  if(JSON.stringify(js(old?.rect_json))===JSON.stringify(r??null))return {ok:true,unchanged:true,revision:Number(old?.revision||0)};
  const revision=Number(old?.revision||0)+1;
  await tx.run("INSERT INTO legacy_pdf_qr_locators(template_id,page_role,rect_json,revision,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE rect_json=VALUES(rect_json),revision=VALUES(revision),updated_by=VALUES(updated_by)",id,role,r?JSON.stringify(r):null,revision,actor(req));
  await audit(tx,"template",id,"qr_locator_edit",actor(req),{pageRole:role,rect:js(old?.rect_json),revision:old?.revision||0},{pageRole:role,rect:r??null,revision});
  return {ok:true,unchanged:false,revision};
 });
}
export function legacyTemplateRouter(){
 const r=Router();r.use((req,res,next)=>{try{manage(req);next();}catch(e){next(e);}});
 r.get("/",wrap(async(req,res)=>{res.json({templates:await db().all<Row>("SELECT id,family_id,revision,title,status,card_id,created_at,archived_at FROM legacy_pdf_templates ORDER BY created_at DESC")});}));
 r.post("/",upload.single("file"),wrap(async(req,res)=>{res.status(201).json(await uploadTemplate(req));}));
 r.get("/:id",wrap(async(req,res)=>{const t=await template(String(req.params.id));res.json({...t,definition:definition(t),locators:await qrLocators(t.id),pages:js(t.pages_json).map((p:Row,i:number)=>({width:p.width,height:p.height,imageUrl:"/api/templates/"+t.id+"/pages/"+(i+1)+"?orientation="+(p.viewRotation||0)}))});}));
 r.put("/:id",wrap(async(req,res)=>{const def=normalizePdfTemplate(req.body.definition),errors=validatePdfTemplate(def);if(errors.length)throw err(400,errors.join("；"));await db().transaction(async tx=>{const t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=? FOR UPDATE",String(req.params.id));if(!t)throw err(404,"模板不存在");if(t.status!=="draft")throw err(409,"已发布版本不可修改，请复制为新版本");if(def.pages.length!==js(t.pages_json).length)throw err(400,"不能修改PDF页数");const refs=js(t.pages_json,[]) as Row[];await orientTemplateRefs(t.id,refs,def);await tx.run("UPDATE legacy_pdf_templates SET title=?,definition_json=?,pages_json=? WHERE id=?",def.title,JSON.stringify(def),JSON.stringify(refs),t.id);await audit(tx,"template",t.id,"edit",actor(req),js(t.definition_json),def);});res.json({ok:true});}));
 r.put("/:id/qr-locator",wrap(async(req,res)=>{res.json(await saveQrLocator(req,String(req.params.id)));}));
 r.post("/:id/publish",wrap(async(req,res)=>{res.json(await publishTemplate(req,String(req.params.id)));}));
 r.post("/:id/archive",wrap(async(req,res)=>{const id=String(req.params.id);await db().transactionWithNamedLock("legacy-template-"+id,2000,async tx=>{const t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=? FOR UPDATE",id);if(!t)throw err(404,"模板不存在");const archived=req.body.archived!==false;if(archived&&(await tx.get<Row>("SELECT id FROM exams WHERE card_id=? LIMIT 1",t.card_id)||await tx.get<Row>("SELECT id FROM legacy_pdf_batches WHERE template_id=? LIMIT 1",id)))throw err(409,"已关联考试或扫描的答题卡不能归档");await tx.run("UPDATE legacy_pdf_templates SET archived_at=? WHERE id=?",archived?databaseTimestamp():null,id);await audit(tx,"template",id,archived?"archive":"restore",actor(req),{archivedAt:t.archived_at},{archived});});res.json({ok:true});}));
 r.post("/:id/clone",wrap(async(req,res)=>{const old=await template(String(req.params.id)),id=uid();await db().transactionWithNamedLock("legacy-family-"+old.family_id,2000,async tx=>{const max=await tx.get<Row>("SELECT MAX(revision) n FROM legacy_pdf_templates WHERE family_id=?",old.family_id);await tx.run("INSERT INTO legacy_pdf_templates(id,family_id,revision,title,definition_json,pdf_hash,pdf_path,pages_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)",id,old.family_id,Number(max?.n||0)+1,old.title,old.definition_json,old.pdf_hash,old.pdf_path,old.pages_json,actor(req));await audit(tx,"template",id,"clone",actor(req),{id:old.id},{id});});res.status(201).json({id});}));
 r.get("/:id/pages/:page",wrap(async(req,res)=>{const t=await template(String(req.params.id)),p=js(t.pages_json)[Number(req.params.page)-1];if(!p)throw err(404,"页面不存在");res.sendFile(p.path);}));
 r.get("/:id/export",wrap(async(req,res)=>{const t=await template(String(req.params.id));res.attachment("answer-card-template-v"+t.revision+".zip");const a=typeof archiver==="function"?archiver("zip",{zlib:{level:1}}):new archiver.ZipArchive({zlib:{level:1}});a.on("error",(e:any)=>res.destroy(e));a.pipe(res);a.file(t.pdf_path,{name:"answer_card.pdf"});a.append(JSON.stringify(definition(t),null,2),{name:"template.json"});await a.finalize();}));
 r.post("/:id/exams",wrap(async(req,res)=>{const t=await template(String(req.params.id));if(t.status!=="published"||t.archived_at)throw err(409,"请选择未归档的已发布答题卡");const c=await db().get<Row>("SELECT * FROM classes WHERE id=?",Number(req.body.classId));if(!c)throw err(400,"请选择应考班级");const result=await db().run("INSERT INTO exams(name,card_id,grade_id,class_id,subject,created_by,review_enabled) VALUES(?,?,?,?,?,?,1)",String(req.body.name||t.title),t.card_id,c.grade_id,c.id,definition(t).subject||"语文",actor(req));await ensureExamParticipants(db(),result.lastInsertRowid);await audit(db(),"exam",String(result.lastInsertRowid),"create_from_template",actor(req),null,{templateId:t.id,classId:c.id});res.status(201).json({id:result.lastInsertRowid});}));
 return r;
}
async function papersDetail(b:Row):Promise<Row[]>{
 const papers=await db().all<Row>("SELECT p.*,u.student_number,u.name student_name,s.serial_no serialNumber FROM legacy_pdf_papers p LEFT JOIN users u ON u.id=p.student_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id WHERE batch_id=? ORDER BY sheet_no",b.id);
 const pages=await db().all<Row>("SELECT * FROM legacy_pdf_pages WHERE batch_id=? ORDER BY source_page",b.id),results=await db().all<Row>("SELECT r.* FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?",b.id);
 return papers.map(p=>({...p,autoIdentity:js(p.auto_identity),pages:pages.filter(x=>x.paper_id===p.id).map(x=>({...x,alignment:js(x.alignment_json),imageUrl:"/api/scan-batches/"+b.id+"/pages/"+x.id+"/image",rawImageUrl:"/api/scan-batches/"+b.id+"/pages/"+x.id+"/image?raw=1"})),results:results.filter(x=>x.paper_id===p.id).map(x=>({...x,auto:js(x.auto_value),final:js(x.final_value)}))}));
}
async function confirmPaper(req:Request,b:Row,pid:string,body:any,normalOnly=false){
 manage(req);const t=await template(b.template_id);
 return db().transactionWithNamedLock("legacy-batch-"+b.id,2000,async tx=>{
 await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);const def=await examDefinition(t,b,tx);
 const p=await tx.get<Row>("SELECT * FROM legacy_pdf_papers WHERE id=? AND batch_id=? FOR UPDATE",pid,b.id);if(!p)throw err(404,"学生卷不存在");
 const hasMarks=!!await tx.get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? LIMIT 1",pid);
 if(Number(body.version)!==Number(p.version))throw err(409,"学生卷已更新，请刷新");
 const studentId=Number(body.studentId||p.student_id||js(p.auto_identity)?.studentId);if(!studentId||!await isExamParticipant(tx,b.exam_id,studentId))throw err(400,"学生不在该考试应考名单内");
 if(hasMarks&&(Number(p.student_id)!==studentId||p.identity_status!=="confirmed"||!p.ownership_confirmed))throw err(409,"任务已生成，不能修改卷归属；客观题答案仍可修改");
 const duplicate=await tx.get<Row>("SELECT id FROM legacy_pdf_papers WHERE batch_id=? AND student_id=? AND id<>?",b.id,studentId,pid);if(duplicate)throw err(409,"同一批次存在重复学生，请先处理卷归属");
 const pages=await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=?",pid);
 const required=new Set(def.questions.filter(q=>q.gradingType==="teacher_score").flatMap(q=>(q.regions||[]).map(r=>r.pageRole)));
 if([...required].some(role=>pages.filter(x=>x.page_role===role&&x.status==="recognized").length!==1)||def.pages.some(role=>pages.filter(x=>x.page_role===role.pageRole).length>1))throw err(409,"主观题页面缺失、重复或未校正，不能确认");
 const answers=body.answers||{},remainingQuestions:Array<{questionId:string;questionNumber:string;reason:string}>=[];let confirmedResults=0;
 for(const q of def.questions.filter(x=>x.gradingType==="objective")){
 const record=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=? FOR UPDATE",pid,q.questionId),auto=js(record?.auto_value);
 if(!Object.hasOwn(answers,q.questionId))continue;
 if(normalOnly&&record?.status==="confirmed")continue;
 const value=Object.hasOwn(answers,q.questionId)?answers[q.questionId]:js(record?.final_value,auto?.value);
 if(!Array.isArray(value)||value.some(v=>!q.options?.some(o=>o.label===v))||new Set(value).size!==value.length)throw err(400,"第"+q.displayNumber+"题答案无效或尚未识别");
 const source=Object.hasOwn(answers,q.questionId)?"manual":record?.final_source||"auto";
 const before={value:js(record?.final_value),status:record?.status,score:record?.score,source:record?.final_source},score=objectivePdfScore(q,value);
 if(record?.status==="confirmed"&&JSON.stringify(before.value)===JSON.stringify(value)&&before.score===score&&record.final_source===source)continue;
 await tx.run("UPDATE legacy_pdf_results SET final_value=?,score=?,status='confirmed',final_source=?,version=version+1 WHERE id=?",JSON.stringify(value),score,source,record!.id);
 await audit(tx,"result",record!.id,"confirm_or_edit",actor(req),before,{value,score,status:"confirmed",source});confirmedResults++;
 if(hasMarks)await tx.run("UPDATE question_scores SET score=?,selected_options=?,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'",score,JSON.stringify(value),actor(req),databaseTimestamp(),b.exam_id,studentId,Number(q.displayNumber));
 }
 const identityConfirmed=p.identity_status!=="confirmed"||!p.ownership_confirmed||Number(p.student_id)!==studentId;
 if(identityConfirmed){
 await tx.run("UPDATE legacy_pdf_papers SET student_id=?,identity_status='confirmed',ownership_confirmed=1,version=version+1 WHERE id=?",studentId,pid);
 await audit(tx,"paper",pid,normalOnly?"confirm_normal_identity":"bind_and_confirm",actor(req),p,{studentId,identityStatus:"confirmed",ownershipConfirmed:true});
 }
 await assignPaperSerial(tx,Number(b.exam_id),pid,actor(req));
 if(confirmedResults&&!identityConfirmed)await tx.run("UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?",pid);
 if(confirmedResults||identityConfirmed){await writeTotals(tx,pid,actor(req));await markScoreMutated(tx,b.exam_id,actor(req),"answer_edit");}
 await queuePaperObjective(tx,b,t,pid);
 return {ok:true,confirmedResults,identityConfirmed,remainingQuestions};
 });
}
async function swapPaperFaces(req:Request,b:Row,pid:string,body:any){
 manage(req);const requestId=String(body.requestId||"");
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw err(400,"交换请求编号无效");
 return db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
  const paper=await tx.get<Row>("SELECT * FROM legacy_pdf_papers WHERE id=? AND batch_id=? FOR UPDATE",pid,b.id);if(!paper)throw err(404,"学生卷不存在");
  const replay=await tx.get<Row>("SELECT after_json FROM legacy_pdf_audit WHERE entity_type='paper' AND entity_id=? AND action='swap_faces' AND JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.requestId'))=? ORDER BY id DESC LIMIT 1",pid,requestId);
  if(replay)return {ok:true,reused:true,...js(replay.after_json)};
  if(Number(body.version)!==Number(paper.version))throw err(409,"学生卷已更新，请刷新后再交换");
  const job=await tx.get<Row>("SELECT status,kind,run_id,payload_json,priority FROM legacy_pdf_jobs WHERE batch_id=? FOR UPDATE",b.id);
  if(!job)throw err(409,"扫描任务记录缺失，请先恢复批次");
  if(job.kind==="objective"&&["queued","running"].includes(job.status))throw err(409,"选择题批次正在重新识别，请完成后再交换正反面");
  if(await tx.get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE paper_id=? AND status='running' LIMIT 1",pid))throw err(409,"本卷正在处理，请完成后再交换");
  if(await tx.get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? LIMIT 1",pid))throw err(409,"本卷已生成主观题任务，不能交换正反面");
  const t=await template(b.template_id),def=definition(t),pages=await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=? AND batch_id=? ORDER BY source_page FOR UPDATE",pid,b.id);
  if(def.pages.length!==2||pages.length!==2||def.pages.some(role=>pages.filter(p=>p.page_role===role.pageRole).length!==1))throw err(409,"交换正反面需要本卷有两页，且各对应一个模板页面");
  if(!Array.isArray(body.pages)||body.pages.length!==2||pages.some(p=>!body.pages.some((x:Row)=>x.id===p.id&&Number(x.version)===Number(p.version))))throw err(409,"页面已更新，请刷新后再交换");
  if(pages.some(p=>["pending","processing"].includes(p.status)))throw err(409,"本卷页面正在识别，请完成后再交换");
  const results=await tx.all<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? FOR UPDATE",pid),roles=pages.map(p=>p.page_role);
  for(let i=0;i<2;i++)await tx.run("UPDATE legacy_pdf_pages SET page_role=?,status='pending',aligned_path=NULL,alignment_json=NULL,recognition_json=NULL,manual_json=NULL,version=version+1 WHERE id=?",roles[1-i],pages[i].id);
  let preserved=0;
  for(const r of results){
   const protect=r.final_value!=null&&r.final_source!=="auto";if(protect)preserved++;
   const after={value:protect?js(r.final_value):null,score:protect?r.score:null,status:protect?r.status:"wait_confirm",source:protect?r.final_source:"auto"};
   await tx.run("UPDATE legacy_pdf_results SET auto_value=NULL,confidence=NULL,final_value=?,score=?,status=?,final_source=?,recognizer_version=NULL,version=version+1 WHERE id=?",protect?r.final_value:null,after.score,after.status,after.source,r.id);
   await audit(tx,"result",r.id,"swap_faces_reset",actor(req),r,{...after,requestId});
  }
  await tx.run("UPDATE legacy_pdf_papers SET ownership_confirmed=0,auto_identity=NULL,version=version+1 WHERE id=?",pid);
  await writeTotals(tx,pid,actor(req));await markScoreMutated(tx,b.exam_id,actor(req),"scanner_retry");
  await tx.run("UPDATE legacy_pdf_stage_jobs SET status='cancelled',error='页面交换使输入失效' WHERE paper_id=? AND status IN('queued','failed')",pid);
  for(const p of await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=?",pid))await queuePreprocess(tx,b,t,p,300);
  await tx.run("UPDATE legacy_pdf_jobs SET status='staged',kind='scan',run_id=NULL,payload_json=NULL,priority=0,lease_until=NULL,error=NULL WHERE batch_id=?",b.id);
  await tx.run("UPDATE legacy_pdf_batches SET status='queued',error=NULL,finished=(SELECT COUNT(*) FROM legacy_pdf_pages WHERE batch_id=? AND status NOT IN('pending','processing')) WHERE id=?",b.id,b.id);
  const after={requestId,batchId:b.id,paperId:pid,paperVersion:Number(paper.version)+1,status:"queued",priority:100,preservedAnswers:preserved,pages:pages.map((p,i)=>({id:p.id,sourcePage:p.source_page,pageRole:roles[1-i],version:Number(p.version)+1}))};
  await audit(tx,"paper",pid,"swap_faces",actor(req),{paper,pages,previousJob:job},after);
  return {ok:true,reused:false,...after};
 });
}
function subjectiveTaskBlock(t:Row,def:ReturnType<typeof definition>,q:ReturnType<typeof definition>["questions"][number]){
 const shared=q.blockId&&def.questions.filter(x=>x.gradingType==="teacher_score"&&x.blockId===q.blockId).length>1;
 return shared?legacyBlockId(t.family_id||t.id,q.questionId):q.blockId||legacyBlockId(t.id,q.questionId);
}
async function generate(req:Request,b:Row,body:Row={}){
 manage(req);const t=await template(b.template_id),def=await examDefinition(t,b),all=await papersDetail(b);
 if(body.paperIds!==undefined&&(!Array.isArray(body.paperIds)||body.paperIds.some((id:any)=>typeof id!=="string"||!all.some(p=>p.id===id))))throw err(400,"所选学生卷不属于本批次");
 const ids=body.paperIds?Array.from(new Set<string>(body.paperIds)):all.map(p=>p.id);
 let count=0,generated=0,existing=0;const skipped:Row[]=[];
 for(const pid of ids){
  try{
   const result=await db().transactionWithNamedLock("legacy-paper-generate-"+pid,5000,async tx=>{
    await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
    const currentBatch=await tx.get<Row>("SELECT exam_id FROM legacy_pdf_batches WHERE id=? FOR UPDATE",b.id);if(Number(currentBatch!.exam_id)!==Number(b.exam_id))throw err(409,"关联考试已变化，请刷新后生成");
    const p=await tx.get<Row>("SELECT * FROM legacy_pdf_papers WHERE id=? AND batch_id=? FOR UPDATE",pid,b.id),pages=await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=? FOR UPDATE",pid);
    const readiness=legacyGenerationReadiness(def,[{...p,pages,results:[]}]);if(!readiness.ready)throw err(409,readiness.papers[0].reasons.join("；"));
    const previous=await tx.get<Row>("SELECT * FROM student_scores WHERE exam_id=? AND student_id=?",b.exam_id,p!.student_id);
    const own=await tx.get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? LIMIT 1",pid);
    if(previous&&!own&&(previous.total_score!=null||await tx.get<Row>("SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p2 ON p2.id=m.paper_id JOIN legacy_pdf_batches b2 ON b2.id=p2.batch_id WHERE b2.exam_id=? AND p2.student_id=? AND p2.id<>? LIMIT 1",b.exam_id,p!.student_id,pid)))throw err(409,"考试已有该学生成绩或其他学生卷任务，不能覆盖");
    await tx.run("INSERT IGNORE INTO student_scores(exam_id,student_id,objective_score,subjective_score,total_score) VALUES(?,?,NULL,NULL,NULL)",b.exam_id,p!.student_id);
    let created=0;
    for(const q of def.questions.filter(q=>q.gradingType==="teacher_score")){
     if(await tx.get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? AND question_id=?",pid,q.questionId))continue;
     const mark=uid(),crop=uid(),block=subjectiveTaskBlock(t,def,q),student=await tx.get<Row>("SELECT student_number FROM users WHERE id=?",p!.student_id);
     await tx.run("INSERT INTO legacy_pdf_marks(id,paper_id,question_id,crop_id) VALUES(?,?,?,?)",mark,pid,q.questionId,crop);
     await tx.run("INSERT INTO answer_block_crops(id,card_id,exam_id,student_id,student_number,source_type,source_record_id,block_id,block_title,block_type,page_number,segment_index,question_numbers,rect_json,image_path,width_px,height_px,dpi,status) VALUES(?,?,?,?,?,'legacy_pdf',?,?,?,'subjective',1,?,?,?,?,1,1,150,'ready')",crop,t.card_id,b.exam_id,p!.student_id,student?.student_number,pid,block,"第"+q.displayNumber+"题",Number(q.displayNumber),JSON.stringify([Number(q.displayNumber)]),JSON.stringify(q.regions),path.join(root,"cache",mark+".png"));created++;
    }
    for(const q of def.questions.filter(q=>q.gradingType==="objective")){
     const r=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=?",pid,q.questionId);
     if(r?.status==="confirmed"&&r.score!=null)await tx.run("INSERT INTO question_scores(exam_id,student_id,question_number,block_id,score,max_score,score_type,selected_options,modified_by,modified_at) VALUES(?,?,?,?,?,?,'objective',?,?,?) ON DUPLICATE KEY UPDATE score=VALUES(score),selected_options=VALUES(selected_options)",b.exam_id,p!.student_id,Number(q.displayNumber),q.blockId||legacyBlockId(t.id,q.questionId),r.score,q.maxScore,r.final_value,actor(req),databaseTimestamp());
    }
    await tx.run("UPDATE legacy_pdf_papers SET subjective_generated=1 WHERE id=?",pid);await writeTotals(tx,pid,actor(req));await queuePaperObjective(tx,b,t,pid);
    await tx.run("UPDATE exams SET review_enabled=1,status=CASE WHEN status='closed' THEN status ELSE 'grading' END WHERE id=?",b.exam_id);
    await tx.run("UPDATE legacy_pdf_batches SET status='marking' WHERE id=?",b.id);
    if(created)await audit(tx,"paper",pid,"generate_subjective_tasks",actor(req),null,{count:created});
    return created;
   });
   count+=result;result?generated++:existing++;
  }catch(e:any){if(![400,409].includes(e.status))throw e;const p=all.find(x=>x.id===pid);skipped.push({paperId:pid,sheetNo:p?.sheet_no,reason:e.message});}
 }
 return {ok:true,count,generated,existing,skipped};
}
/** Caller owns the transaction; every objective/scan/review path delegates here. */
async function writeTotals(tx:DbAdapter,pid:string,user:number){
 const p=await tx.get<Row>("SELECT p.*,b.exam_id,b.template_id,b.answer_key_json FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE p.id=?",pid);
 if(!p)throw err(404,"学生卷不存在");
 const context=await readReviewGroupScoreContext(tx,Number(p.exam_id),[pid],true);
 const t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",p.template_id),def=await examDefinition(t!,p,tx);
 const results=await tx.all<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=?",pid),marks=await tx.all<Row>("SELECT * FROM legacy_pdf_marks WHERE paper_id=?",pid);
 // Child values are preserved as history. Group scores never enter this ledger.
 await syncSerialScores(tx,pid,def,results,marks);
 const serial=await tx.get<Row>("SELECT exam_id,serial_no FROM legacy_paper_serials WHERE paper_id=?",pid);
 const effective=effectiveLegacyPaperScores({examId:Number(p.exam_id),paperId:pid,serialNumber:serial&&Number(serial.exam_id)===Number(p.exam_id)?Number(serial.serial_no):null,def,results,marks,groups:context.groups,groupScores:context.scores});
 const complete=p.identity_status==="confirmed"&&!!p.ownership_confirmed&&effective.scoringComplete,total=complete?effective.total:null;
 await tx.run("UPDATE student_scores SET objective_score=?,subjective_score=?,total_score=?,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=?",effective.objectiveComplete?effective.objective:null,effective.subjectiveComplete?effective.subjective:null,total,user,databaseTimestamp(),p.exam_id,p.student_id);
 return total;
}
/** Pass the existing transaction adapter after saving the independent group row. */
export async function recomputeLegacyPaperTotals(adapter:DbAdapter,paperId:string,actor:number):Promise<number|null>{
 return writeTotals(adapter,paperId,actor);
}
export async function submitLegacyCropScore(params:any,adapter:DbAdapter=getMysqlDb()){
 const initial=await adapter.get<Row>("SELECT m.*,p.batch_id,p.student_id,b.exam_id,b.template_id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE crop_id=?",params.cropId);
 if(!initial||Number(initial.exam_id)!==Number(params.examId))throw err(404,"主观题任务不存在");
 const t=await adapter.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",initial.template_id),q=t&&definition(t).questions.find(q=>q.questionId===initial.question_id);
 if(!q)throw err(409,"题目配置已变化，请刷新");
 const score=Number(params.blockTotalScore??params.scores?.find((s:any)=>Number(s.questionNumber)===Number(q.displayNumber))?.score);
 const result=await adapter.transaction(async tx=>{
 // Lock even draft config before any score write; activation waits for this commit.
 await assertLegacyQuestionNotGrouped(tx,Number(initial.exam_id),q.displayNumber);
 if(!Number.isFinite(score)||score<0||score>q.maxScore)throw err(422,"分数须在0到"+q.maxScore+"之间");
 const m=await tx.get<Row>("SELECT * FROM legacy_pdf_marks WHERE id=? FOR UPDATE",initial.id),crop=await tx.get<Row>("SELECT * FROM answer_block_crops WHERE id=? FOR UPDATE",params.cropId);
 if(!m||!crop)throw err(404,"主观题任务不存在");
 if(!params.isAdmin&&crop!.claimed_by!==params.userId&&!(m!.status==="reviewed"&&crop!.reviewer_id===params.userId))throw err(403,"请先领取本人分配的试卷");
 if(m!.status==="reviewed"&&Number(m!.score)===score){const totals=await tx.get<Row>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?",initial.exam_id,initial.student_id);return {ok:true as const,cropId:params.cropId,status:"reviewed",totalScore:score,paperTotalScore:totals?.total_score==null?null:Number(totals.total_score),finalScore:score,reviewRound:m!.version,reused:true};}
 // A crop has one assigned reviewer. If an older tab is submitted later, its
 // score becomes the latest committed value, matching the grading workflow.
 await tx.run("UPDATE legacy_pdf_marks SET score=?,status='reviewed',version=version+1 WHERE id=?",score,m!.id);
 const before={score:m!.score,status:m!.status,version:m!.version},after={score,status:"reviewed",version:Number(m!.version)+1,round:Number(crop!.review_round||0)+1,reviewerId:params.userId,reviewedAt:databaseTimestamp(),questionScores:{[q.displayNumber]:score}};
 await audit(tx,"mark",m!.id,m!.score==null?"score":"rescore",params.userId,before,after);
 await tx.run("UPDATE answer_block_crops SET status='reviewed',final_score=?,reviewer_id=?,reviewed_at=?,claimed_by=NULL,claimed_at=NULL,review_round=review_round+1,score_breakdown=? WHERE id=?",score,params.userId,databaseTimestamp(),JSON.stringify([after]),params.cropId);
 await tx.run("INSERT INTO question_scores(exam_id,student_id,question_number,block_id,score,max_score,score_type,manually_modified,modified_by,modified_at) VALUES(?,?,?,?,?,?,'subjective',1,?,?) ON DUPLICATE KEY UPDATE score=VALUES(score),modified_by=VALUES(modified_by),modified_at=VALUES(modified_at)",initial.exam_id,initial.student_id,Number(q.displayNumber),crop!.block_id,score,q.maxScore,params.userId,databaseTimestamp());
 const total=await writeTotals(tx,initial.paper_id,params.userId);await markScoreMutated(tx,initial.exam_id,params.userId,"review_submit");
 return {ok:true as const,cropId:params.cropId,status:"reviewed",totalScore:score,paperTotalScore:total,finalScore:score,reviewRound:Number(m!.version)+1,reused:false};
 });
 if(!result.reused){const pending=await adapter.get<Row>("SELECT COUNT(*) n FROM student_scores WHERE exam_id=? AND total_score IS NULL",initial.exam_id);if(!Number(pending?.n))await recomputeExamRankings(adapter,initial.exam_id).catch(()=>{});}
 return result;
}
async function gradingImageForTransfer(source:string):Promise<string>{
 if(source.endsWith(".webp"))return source;
 const target=source+".webp";
 if(existsSync(target))return target;
 const temporary=target+"."+uid()+".tmp";
 try{
  // Preserve handwriting while reducing the bytes transferred on mobile networks.
  await sharp(source).webp({quality:90,effort:3}).toFile(temporary);
  await rename(temporary,target);
  return target;
 }catch(error){
  console.warn("[LegacyPdf] WebP transfer fallback:",error);
  return source;
 }finally{
  await rm(temporary,{force:true}).catch(()=>{});
 }
}
export async function legacyCropImage(cropId:string):Promise<string|null>{
 const imported=await importedCropImage(cropId);if(imported)return gradingImageForTransfer(imported);
 const m=await db().get<Row>("SELECT m.*,p.batch_id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE crop_id=?",cropId);if(!m)return null;
 const b=await db().get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=?",m.batch_id),t=await template(b!.template_id),q=definition(t).questions.find(q=>q.questionId===m.question_id)!;
 const pages=await db().all<Row>("SELECT * FROM legacy_pdf_pages WHERE paper_id=?",m.paper_id);
 const key=createHash("sha256").update(JSON.stringify({q,pages:pages.map(p=>[p.id,p.version])})).digest("hex").slice(0,16),target=path.join(root,"cache",m.id+"_"+key+".png");
 if(existsSync(target))return gradingImageForTransfer(target);
 const segments:Array<{input:Buffer;top:number;left:number}>=[];
 let width=0,height=0;for(const region of [...(q.regions||[])].sort((a,b)=>a.order-b.order)){
 const p=pages.find(p=>p.page_role===region.pageRole&&p.status==="recognized");if(!p)throw err(409,"题目页面未校正");
 const meta=await sharp(p.aligned_path).metadata(),r=region.rect;const x=Math.max(0,Math.floor(r.x*meta.width!)),y=Math.max(0,Math.floor(r.y*meta.height!)),w=Math.min(meta.width!-x,Math.max(1,Math.ceil(r.width*meta.width!))),h=Math.min(meta.height!-y,Math.max(1,Math.ceil(r.height*meta.height!)));
 const image=await sharp(p.aligned_path).extract({left:x,top:y,width:w,height:h}).png().toBuffer();segments.push({input:image,left:0,top:height});width=Math.max(width,w);height+=h+16;
 }
 if(!segments.length)throw err(409,"缺少主观题区域");
 await cropCacheQuota();await mkdir(path.dirname(target),{recursive:true});const tmp=target+"."+uid()+".tmp";await sharp({create:{width,height:height-16,channels:3,background:"#ffffff"}}).composite(segments).png().toFile(tmp);await copyFile(tmp,target);await rm(tmp,{force:true});return gradingImageForTransfer(target);
}
export async function assertLegacyScoresReady(adapter:DbAdapter,examId:number){
 const batches=await adapter.all<Row>("SELECT id,template_id FROM legacy_pdf_batches WHERE exam_id=?",examId);if(!batches.length)return;
 await assertLegacyObjectiveIdle(adapter,examId);
 const context=await readReviewGroupScoreContext(adapter,examId,undefined,true);
 for(const b of batches){
  const ps=await adapter.all<Row>("SELECT p.*,s.serial_no serialNumber FROM legacy_pdf_papers p LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=? WHERE p.batch_id=?",examId,b.id);
  if(!ps.length||ps.some(p=>p.identity_status!=="confirmed"||!p.ownership_confirmed))throw err(409,"自定义PDF学生卷尚未全部确认");
  const t=await adapter.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",b.template_id),def=await examDefinition(t!,{...b,exam_id:examId},adapter);
  for(const p of ps){
   const results=await adapter.all<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=?",p.id),marks=await adapter.all<Row>("SELECT * FROM legacy_pdf_marks WHERE paper_id=?",p.id);
   const effective=effectiveLegacyPaperScores({examId,paperId:p.id,serialNumber:p.serialNumber,def,results,marks,groups:context.groups,groupScores:context.scores});
   const scores=await adapter.get<Row>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?",examId,p.student_id);
   if(!effective.scoringComplete||scores?.total_score==null||Math.abs(Number(scores.total_score)-effective.total!)>0.000001)
    throw err(409,"自定义PDF阅卷尚未完成或总分需重新计算，不能发布最终成绩");
  }
 }
}
export async function legacyBatchScoreSummary(b:Row,adapter:DbAdapter=db()){
 const t=await adapter.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",b.template_id),def=await examDefinition(t!,b,adapter);
 const papers=await adapter.all<Row>("SELECT p.*,u.student_number,u.name student_name,s.serial_no serialNumber FROM legacy_pdf_papers p LEFT JOIN users u ON u.id=p.student_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=? WHERE p.batch_id=? ORDER BY p.sheet_no",b.exam_id,b.id);
 const ledger=await adapter.all<Row>("SELECT s.* FROM legacy_serial_question_scores s JOIN legacy_pdf_papers p ON p.id=s.paper_id WHERE p.batch_id=? AND s.exam_id=?",b.id,b.exam_id);
 const context=await readReviewGroupScoreContext(adapter,Number(b.exam_id),papers.map(p=>p.id));
 const running=!!await adapter.get<Row>("SELECT batch_id FROM legacy_pdf_jobs WHERE batch_id=? AND kind='objective' AND status IN('queued','running')",b.id)||!!await adapter.get<Row>("SELECT batch_id FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective' AND status IN('queued','running')",b.id);
 const columns=legacyGroupedQuestionColumns(def.questions.map(q=>({number:q.displayNumber,kind:q.gradingType,maxScore:q.maxScore,question:q})),context.groups,context.scores);
 const questions=columns.map(c=>{const original=c.groupId?undefined:c.question;return {...original,questionId:original?.questionId||c.number,displayNumber:c.number,gradingType:c.kind,maxScore:c.maxScore,answer:original?.answer??null,historical:!!c.historical,groupId:c.groupId,title:c.title};});
 return {batch:b,questions,reviewGroups:context.groups,objectiveReprocessing:running,students:papers.map(p=>{
  const records=ledger.filter(r=>r.paper_id===p.id&&Number(r.serial_no)===Number(p.serialNumber));
  const effective=effectiveLegacyPaperScores({examId:Number(b.exam_id),paperId:p.id,serialNumber:p.serialNumber,def,results:records.filter(r=>r.kind==="objective"),marks:records.filter(r=>r.kind==="teacher_score"),groups:context.groups,groupScores:context.scores});
  const complete=!running&&p.identity_status==="confirmed"&&!!p.ownership_confirmed&&effective.scoringComplete;
  return {id:p.id,sheetNo:p.sheet_no,serialNumber:p.serialNumber,studentNumber:p.student_number,studentName:p.student_name,scores:effective.scores,historicalScores:effective.historicalScores,groupScores:effective.groupScores,historicalQuestionNumbers:effective.historicalQuestionNumbers,complete,total:complete?effective.total:null};
 })};
}
async function summary(b:Row){return legacyBatchScoreSummary(b);}

async function changeBatchExam(req:Request,b:Row){
 manage(req);const targetId=Number(req.body.examId);
 if(!Number.isSafeInteger(targetId)||targetId<1)throw err(400,"请选择关联考试");
 const visible=await getVisibleExamIds(req.user);if(visible&&!visible.includes(targetId))throw err(403,"无权管理目标考试");
 const result=await db().transactionWithNamedLock("legacy-batch-"+b.id,10000,async tx=>{
  for(const id of [...new Set([Number(b.exam_id),targetId])].sort((a,b)=>a-b))await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",id);
  const current=await tx.get<Row>("SELECT * FROM legacy_pdf_batches WHERE id=? FOR UPDATE",b.id);
  if(Number(current!.exam_id)===targetId)return {ok:true,reused:true,examId:targetId};
  if(Number(current!.exam_id)!==Number(req.body.expectedExamId))throw err(409,"关联考试已变化，请刷新");
  const target=await tx.get<Row>("SELECT * FROM exams WHERE id=?",targetId),t=await tx.get<Row>("SELECT * FROM legacy_pdf_templates WHERE id=?",current!.template_id);
  if(!target||target.card_id!==t!.card_id)throw err(400,"只能调整到使用同一答题卡模板的考试");
  if(target.status==="closed")throw err(409,"目标考试已关闭，请先在考试管理中开启");
  if(await tx.get<Row>("SELECT id FROM legacy_pdf_batches WHERE exam_id=? AND template_id=? AND pdf_hash=? AND id<>? LIMIT 1",targetId,t!.id,current!.pdf_hash,b.id))throw err(409,"目标考试已有这份PDF，请打开原批次");
  const stages=await tx.all<Row>("SELECT id,status FROM legacy_pdf_stage_jobs WHERE batch_id=? ORDER BY id FOR UPDATE",b.id);
  if(stages.some(j=>j.status==="running")||await tx.get<Row>("SELECT batch_id FROM legacy_pdf_jobs WHERE batch_id=? AND kind='objective' AND status='running'",b.id))throw err(409,"当前页正在处理，请稍后调整");
  const papers=await tx.all<Row>("SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY id FOR UPDATE",b.id);
  const crops=await tx.all<Row>("SELECT c.* FROM answer_block_crops c JOIN legacy_pdf_marks m ON m.crop_id=c.id JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? FOR UPDATE",b.id);
  if(crops.some(c=>c.claimed_by!=null||c.reviewer_id!=null||c.status==="reviewed")||await tx.get<Row>("SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? AND m.score IS NOT NULL LIMIT 1",b.id))throw err(409,"已有教师领取或评分，请先处理阅卷任务；不会搬动或清空教师评分");
  const targetRoster=await roster(targetId,tx),rosterIds=new Set(targetRoster.map(r=>Number(r.id)));
  const students=[...new Set(papers.filter(p=>p.student_id!=null).map(p=>Number(p.student_id)))];
  for(const studentId of students){
   if(!rosterIds.has(studentId))throw err(409,"目标考试名单未包含本批已绑定学生，请先调整应考名单");
   if(await tx.get<Row>("SELECT p.id FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.exam_id=? AND p.student_id=? AND b.id<>? LIMIT 1",targetId,studentId,current!.id)||await tx.get<Row>("SELECT student_id FROM student_scores WHERE exam_id=? AND student_id=? LIMIT 1",targetId,studentId))throw err(409,"目标考试已有本批学生的卷子或成绩，不能覆盖");
   if(await tx.get<Row>("SELECT p.id FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.exam_id=? AND p.student_id=? AND b.id<>? LIMIT 1",current!.exam_id,studentId,current!.id))throw err(409,"原考试存在同一学生的其他批次，不能混移成绩");
   if(await tx.get<Row>("SELECT id FROM answer_block_crops WHERE exam_id=? AND student_id=? AND (source_type<>'legacy_pdf' OR source_record_id NOT IN ("+papers.map(()=>"?").join(",")+")) LIMIT 1",current!.exam_id,studentId,...papers.map(p=>p.id)))throw err(409,"原考试还有本批以外的学生作答记录，不能混移成绩");
   const assigned=await tx.all<Row>("SELECT assigned_student_ids FROM review_assignments WHERE exam_id=?",current!.exam_id);
   if(assigned.some(a=>js(a.assigned_student_ids,[]).map(Number).includes(studentId)))throw err(409,"本批已有教师分配，请先处理分配后调整");
   if(await tx.get<Row>("SELECT student_id FROM question_scores WHERE exam_id=? AND student_id=? AND score_type='subjective' LIMIT 1",current!.exam_id,studentId))throw err(409,"已有主观题评分，不能直接调整");
  }
  await tx.run("UPDATE legacy_pdf_stage_jobs SET status='cancelled',lease_until=NULL WHERE batch_id=? AND status IN('queued','failed')",b.id);
  await tx.run("UPDATE legacy_pdf_batches SET exam_id=?,answer_key_json=NULL WHERE id=?",targetId,b.id);
  await tx.run("UPDATE answer_block_crops c JOIN legacy_pdf_marks m ON m.crop_id=c.id JOIN legacy_pdf_papers p ON p.id=m.paper_id SET c.exam_id=? WHERE p.batch_id=?",targetId,b.id);
  for(const studentId of students){
   await tx.run("UPDATE question_scores SET exam_id=? WHERE exam_id=? AND student_id=? AND score_type='objective'",targetId,current!.exam_id,studentId);
   await tx.run("UPDATE student_scores SET exam_id=? WHERE exam_id=? AND student_id=?",targetId,current!.exam_id,studentId);
  }
  const next={...current,exam_id:targetId,answer_key_json:null},def=await examDefinition(t!,next,tx);
  for(const paper of papers){
   await assignPaperSerial(tx,targetId,paper.id,actor(req));
   for(const q of def.questions.filter(q=>q.gradingType==="objective")){
    const rec=await tx.get<Row>("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id=? FOR UPDATE",paper.id,q.questionId);if(!rec)continue;
    const score=rec.final_value==null?null:objectivePdfScore(q,js(rec.final_value));
    await tx.run("UPDATE legacy_pdf_results SET score=?,version=version+1 WHERE id=?",score,rec.id);
    if(paper.student_id)await tx.run("UPDATE question_scores SET score=?,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'",score,actor(req),databaseTimestamp(),targetId,paper.student_id,Number(q.displayNumber));
    await audit(tx,"result",rec.id,"exam_binding_rescore",actor(req),{examId:current!.exam_id,value:js(rec.final_value),score:rec.score},{examId:targetId,value:js(rec.final_value),score});
   }
   await tx.run("UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?",paper.id);await writeTotals(tx,paper.id,actor(req));
   await queuePaperObjective(tx,next,t!,paper.id);
  }
  await tx.run("UPDATE legacy_pdf_pages SET status='pending' WHERE batch_id=? AND status='failed'",b.id);
  const pendingPages=await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE batch_id=? AND status IN('pending','processing')",b.id);
  for(const page of pendingPages)await queuePreprocess(tx,next,t!,page,200);
  await tx.run("UPDATE legacy_pdf_jobs SET kind='scan',status=?,error=NULL,lease_until=NULL WHERE batch_id=?",pendingPages.length?"staged":"done",b.id);
  if(crops.length)await tx.run("UPDATE exams SET review_enabled=1,status='grading' WHERE id=?",targetId);
  await markScoreMutated(tx,current!.exam_id,actor(req),"answer_edit");await markScoreMutated(tx,targetId,actor(req),"answer_edit");
  await audit(tx,"batch",b.id,"change_exam_binding",actor(req),{examId:current!.exam_id},{examId:targetId,cropsPreserved:crops.length,objectiveAnswersPreserved:true});
  return {ok:true,reused:false,examId:targetId,examName:target.name};
 });return result;
}
export function legacyBatchRouter(){
 const r=Router();
 r.use("/:id",async(req,res,next)=>{try{if(req.method!=="GET"&&req.method!=="HEAD"){const imported=await db().get<Row>("SELECT id FROM legacy_pdf_batches WHERE id=? AND source_kind='review_import'",String(req.params.id));if(imported)throw err(409,"此批次为历史阅卷原图迁入，请在考试网阅继续评分；不能执行扫描或换页");}next();}catch(e){next(e);}});
 r.get("/",wrap(async(req,res)=>{const ids=await getVisibleExamIds(req.user);res.json({batches:await db().all<Row>(`SELECT b.*,e.name exam_name,t.title template_title,
   COALESCE(pc.paper_count,0) paper_count,COALESCE(pc.identity_issue_count,0) identity_issue_count,
   COALESCE(pc.objective_pending_count,0) objective_pending_count
   FROM legacy_pdf_batches b JOIN exams e ON e.id=b.exam_id JOIN legacy_pdf_templates t ON t.id=b.template_id
   LEFT JOIN (SELECT p.batch_id,COUNT(*) paper_count,
      SUM(CASE WHEN p.identity_status='confirmed' AND p.ownership_confirmed=1 AND p.student_id IS NOT NULL THEN 0 ELSE 1 END) identity_issue_count,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM legacy_pdf_results r WHERE r.paper_id=p.id AND r.auto_value IS NULL) THEN 1 ELSE 0 END) objective_pending_count
      FROM legacy_pdf_papers p GROUP BY p.batch_id) pc ON pc.batch_id=b.id`
   +(ids?" WHERE b.exam_id IN("+[...ids,0].map(()=>"?").join(",")+")":"")+" ORDER BY b.created_at DESC",...(ids?[...ids,0]:[])),worker:{busy:workerBusy,pause:workerPause}});}));
 r.put("/:id/exam",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id));res.json(await changeBatchExam(req,b));}));
 r.get("/options",wrap(async(req,res)=>{manage(req);res.json({exams:await db().all<Row>("SELECT id,name,card_id FROM exams ORDER BY id DESC"),classes:await db().all<Row>("SELECT id,name,grade_id FROM classes ORDER BY grade_id,sort_order,id"),teachers:await db().all<Row>("SELECT id,name,subject FROM users WHERE role_id=2 AND is_active=1")});}));
 r.get("/exams/:exam/answer-key",wrap(async(req,res)=>{manage(req);const examId=Number(req.params.exam),ids=await getVisibleExamIds(req.user);if(ids&&!ids.includes(examId))throw err(403,"无权管理该考试");const {e,t}=await examTemplate(examId);res.json({examId,examName:e.name,templateId:t.id,revision:t.revision,definition:await examDefinition(t,{exam_id:examId})});}));
 r.put("/exams/:exam/answer-key",wrap(async(req,res)=>{manage(req);const examId=Number(req.params.exam),ids=await getVisibleExamIds(req.user);if(ids&&!ids.includes(examId))throw err(403,"无权管理该考试");res.json(await saveExamKeys(req,examId,req.body.answers));}));
 r.post("/",upload.single("file"),wrap(async(req,res)=>{if(!req.file)throw err(400,"请选择扫描PDF");try{res.status(202).json(await createLegacyBatch(req,req.file,String(req.body.templateId),Number(req.body.examId)));}finally{await rm(req.file.path,{force:true});}}));
 r.get("/:id",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id)),t=await template(b.template_id);if(!manager(req)){res.json({batch:b,template:{id:t.id,title:t.title},worker:{busy:workerBusy,pause:workerPause}});return;}res.json({batch:b,template:{...t,definition:await examDefinition(t,b)},papers:await papersDetail(b),roster:await roster(b.exam_id),objectiveRun:await objectiveProgress(b.id),progress:await stageProgress(b),worker:{busy:workerBusy,pause:workerPause}});}));
 r.put("/:id/objective-mode",wrap(async(req,res)=>{
  manage(req);const b=await batchAccess(req,String(req.params.id)),mode=req.body.mode;
  if(!["background_auto","manual"].includes(mode))throw err(400,"客观题模式无效");
  await db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
   await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
   await tx.run("UPDATE legacy_pdf_batches SET objective_mode=?,objective_requested=0,objective_paused=? WHERE id=?",mode,mode==="manual"?1:0,b.id);
   if(mode==="background_auto"){const t=await template(b.template_id);for(const p of await tx.all<Row>("SELECT id FROM legacy_pdf_papers WHERE batch_id=?",b.id))await queuePaperObjective(tx,b,t,p.id);}
   await audit(tx,"batch",b.id,"objective_mode",actor(req),{mode:b.objective_mode},{mode});
  });res.json({ok:true,mode});
 }));
 r.post("/:id/objective-control",wrap(async(req,res)=>{
  manage(req);const b=await batchAccess(req,String(req.params.id)),action=req.body.action;if(!["start","pause","resume"].includes(action))throw err(400,"客观题操作无效");
  let queued=0;await db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{
   await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",b.exam_id);
   await tx.run("UPDATE legacy_pdf_batches SET objective_paused=?,objective_requested=IF(?='pause',objective_requested,1) WHERE id=?",action==="pause"?1:0,action,b.id);
   if(action!=="pause"){
    const t=await template(b.template_id);for(const p of await tx.all<Row>("SELECT id FROM legacy_pdf_papers WHERE batch_id=?",b.id)){if(await queuePaperObjective(tx,b,t,p.id,true))queued++;}
    await tx.run("UPDATE legacy_pdf_stage_jobs SET status='queued',error=NULL WHERE batch_id=? AND kind='objective' AND status='failed'",b.id);
   }
   await audit(tx,"batch",b.id,"objective_control",actor(req),{paused:b.objective_paused},{action,queued});
  });res.json({ok:true,action,queued});
 }));
 r.post("/:id/reprocess-objective",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id));res.status(202).json(await enqueueObjective(req,b));}));
 r.get("/:id/original",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id));if(b.source_kind==="review_import")throw err(409,"该批次保留的是历史阅卷分题原图，没有伪造扫描PDF");res.setHeader("Content-Type","application/pdf");res.attachment("original-scan.pdf");res.sendFile(b.pdf_path);}));
 r.get("/:id/pages/:page/image",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id)),p=await db().get<Row>("SELECT * FROM legacy_pdf_pages WHERE id=? AND batch_id=?",String(req.params.page),b.id);if(!p)throw err(404,"页面不存在");const file=req.query.raw==="1"?p.raw_path:p.aligned_path||p.raw_path;if(!existsSync(file))throw err(409,"页面正在生成");res.sendFile(file);}));
 r.post("/:id/retry",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id));if(workerBusy&&b.status==="analyzing")throw err(409,"正在处理，请稍后");await db().transactionWithNamedLock("legacy-batch-"+b.id,5000,async tx=>{await assertNoObjectiveRun(tx,b.id);const t=await template(b.template_id);const pages=await tx.all<Row>("SELECT * FROM legacy_pdf_pages WHERE batch_id=? AND status IN('wait_alignment','failed')",b.id);for(const p of pages){if(await tx.get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? LIMIT 1",p.paper_id))continue;await tx.run("UPDATE legacy_pdf_pages SET status='pending',version=version+1 WHERE id=?",p.id);await queuePreprocess(tx,b,t,{...p,version:Number(p.version)+1},300);}await tx.run("UPDATE legacy_pdf_jobs SET status='staged',kind='scan',error=NULL WHERE batch_id=?",b.id);await tx.run("UPDATE legacy_pdf_batches SET status='queued',error=NULL WHERE id=?",b.id);await audit(tx,"batch",b.id,"retry",actor(req),{status:b.status},{status:"queued"});});res.json({ok:true});}));
 r.put("/:id/pages/:page",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id)),t=await template(b.template_id),def=definition(t,b);
 const p=await db().get<Row>("SELECT * FROM legacy_pdf_pages WHERE id=? AND batch_id=?",String(req.params.page),b.id);if(!p)throw err(404,"页面不存在");const paperId=String(req.body.paperId||p.paper_id),role=String(req.body.pageRole||p.page_role);if(!def.pages.some(x=>x.pageRole===role)||!await db().get<Row>("SELECT id FROM legacy_pdf_papers WHERE id=? AND batch_id=?",paperId,b.id))throw err(400,"页角色或学生卷无效");
 if(await db().get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id IN(?,?) LIMIT 1",p.paper_id,paperId))throw err(409,"相关学生卷已生成主观题任务，不能移动或重新校正页面");
 const points=req.body.manualPoints;if(points&&(!Array.isArray(points)||points.length!==4||points.some((v:any)=>!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<0||v.x>1||v.y<0||v.y>1)))throw err(400,"人工定位须为页面内四个点");
 await db().transactionWithNamedLock("legacy-batch-"+b.id,2000,async tx=>{await assertNoObjectiveRun(tx,b.id);if(await tx.get<Row>("SELECT id FROM legacy_pdf_stage_jobs WHERE page_id=? AND status='running'",p.id))throw err(409,"本页正在处理，请完成后再修改");await tx.run("UPDATE legacy_pdf_pages SET paper_id=?,page_role=?,manual_json=?,status='pending',aligned_path=NULL,recognition_json=NULL,version=version+1 WHERE id=?",paperId,role,points?JSON.stringify(points):p.manual_json,p.id);
 for(const id of new Set([paperId,p.paper_id])){await tx.run("UPDATE legacy_pdf_papers SET ownership_confirmed=0,identity_status='wait_confirm',version=version+1 WHERE id=?",id);await tx.run("UPDATE legacy_pdf_results SET auto_value=NULL,final_value=IF(final_source='auto',NULL,final_value),score=IF(final_source='auto',NULL,score),status=IF(final_source='auto','wait_confirm',status),version=version+1 WHERE paper_id=?",id);await tx.run("UPDATE legacy_pdf_stage_jobs SET status='cancelled',error='页面修改使输入失效' WHERE paper_id=? AND status IN('queued','failed')",id);}
 await queuePreprocess(tx,b,t,(await tx.get<Row>("SELECT * FROM legacy_pdf_pages WHERE id=?",p.id))!,300);await tx.run("UPDATE legacy_pdf_jobs SET status='staged',kind='scan' WHERE batch_id=?",b.id);await tx.run("UPDATE legacy_pdf_batches SET status='queued',error=NULL WHERE id=?",b.id);await audit(tx,"page",p.id,"manual_alignment_or_ownership",actor(req),p,{paperId,pageRole:role,manualPoints:points});});res.json({ok:true});}));
 r.post("/:id/papers/:paper/swap-faces",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id));res.json(await swapPaperFaces(req,b,String(req.params.paper),req.body));}));
 r.post("/:id/papers/:paper/confirm",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id));res.json(await confirmPaper(req,b,String(req.params.paper),req.body));}));
 r.post("/:id/confirm-normal",wrap(async(req,res)=>{
 manage(req);const b=await batchAccess(req,String(req.params.id)),papers=await papersDetail(b);
 let confirmed=0,confirmedIdentities=0,confirmedResults=0,unchanged=0;const skipped:Row[]=[],candidateCounts=new Map<number,number>();
 for(const p of papers){const sid=Number(p.student_id||(p.autoIdentity?.status==="candidate"?p.autoIdentity.studentId:0));if(sid)candidateCounts.set(sid,(candidateCounts.get(sid)||0)+1);}
 for(const p of papers){
 try{
 const existingIdentity=p.identity_status==="confirmed"&&p.ownership_confirmed&&p.student_id;
 if(!existingIdentity){
 if(p.autoIdentity?.status!=="candidate"||p.autoIdentity.confidence<.75)throw err(409,"身份候选需人工核对");
 if((candidateCounts.get(Number(p.autoIdentity.studentId))||0)>1)throw err(409,"重复身份候选，请先人工核对");
 }
 if(await db().get<Row>("SELECT id FROM legacy_pdf_marks WHERE paper_id=? LIMIT 1",p.id)){unchanged++;continue;}
 const result=await confirmPaper(req,b,p.id,{version:p.version,studentId:existingIdentity||p.autoIdentity.studentId},true);
 confirmedIdentities+=Number(result.identityConfirmed);confirmedResults+=result.confirmedResults;
 if(result.remainingQuestions.length)skipped.push({paperId:p.id,sheetNo:p.sheet_no,studentNumber:p.student_number||p.autoIdentity?.studentNumber,studentName:p.student_name||p.autoIdentity?.name,message:"身份及识别答案已保存，未识别题仍待处理",questions:result.remainingQuestions});
 else if(result.identityConfirmed||result.confirmedResults)confirmed++;else unchanged++;
 }catch(e:any){skipped.push({paperId:p.id,sheetNo:p.sheet_no,studentNumber:p.student_number||p.autoIdentity?.studentNumber,studentName:p.student_name||p.autoIdentity?.name,message:e.message,questions:[]});}
 }
 res.json({confirmed,confirmedIdentities,confirmedResults,unchanged,skipped});
 }));
 r.put("/:id/answer-key",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id));res.json(await saveExamKeys(req,b.exam_id,req.body.answers));}));
 r.post("/:id/generate",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id));res.json(await generate(req,b,req.body));}));
 r.get("/:id/marks",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id)),t=await template(b.template_id),def=definition(t,b),marks=await db().all<Row>("SELECT m.*,p.sheet_no,s.serial_no serialNumber,c.block_id,c.claimed_by,c.reviewer_id,c.student_id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id JOIN answer_block_crops c ON c.id=m.crop_id WHERE p.batch_id=? ORDER BY p.sheet_no",b.id);const visible:Row[]=[];for(const m of marks){if(!manager(req)){if(!await canGradeBlock(req.user,b.exam_id,m.block_id))continue;const as=await db().all<Row>("SELECT assigned_student_ids FROM review_assignments WHERE exam_id=? AND block_id=? AND teacher_id=?",b.exam_id,m.block_id,actor(req));if(!as.length||!as.some(a=>js(a.assigned_student_ids,[]).map(Number).includes(Number(m.student_id))))continue;}const q=def.questions.find(q=>q.questionId===m.question_id)!;visible.push({...m,questionNumber:q.displayNumber,maxScore:q.maxScore,imageUrl:"/api/scan-batches/"+b.id+"/marks/"+m.id+"/image"});}res.json({marks:visible});}));
 async function markAccess(req:Request,b:Row,id:string){const m=await db().get<Row>("SELECT m.*,p.batch_id,c.block_id,c.claimed_by FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id JOIN answer_block_crops c ON c.id=m.crop_id WHERE m.id=? AND p.batch_id=?",id,b.id);if(!m)throw err(404,"任务不存在");if(!manager(req)&&!await canGradeBlock(req.user,b.exam_id,m.block_id))throw err(403,"未授权该题块");if(!manager(req)&&m.claimed_by!==actor(req)){const assigned=await db().all<Row>("SELECT assigned_student_ids FROM review_assignments WHERE exam_id=? AND block_id=? AND teacher_id=?",b.exam_id,m.block_id,actor(req)),paper=await db().get<Row>("SELECT student_id FROM legacy_pdf_papers WHERE id=?",m.paper_id);if(!assigned.some(a=>js(a.assigned_student_ids,[]).map(Number).includes(Number(paper?.student_id))))throw err(403,"未分配该学生卷");}return m;}
 r.get("/:id/marks/:mark/image",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id)),m=await markAccess(req,b,String(req.params.mark)),file=await legacyCropImage(m.crop_id);res.sendFile(file!);}));
 r.post("/:id/marks/:mark/claim",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id)),m=await markAccess(req,b,String(req.params.mark));await claimSpecificPaper(b.exam_id,m.block_id,m.crop_id,actor(req),db(),{privileged:manager(req)});res.json({ok:true});}));
 r.put("/:id/marks/:mark/score",wrap(async(req,res)=>{const b=await batchAccess(req,String(req.params.id)),m=await markAccess(req,b,String(req.params.mark)),t=await template(b.template_id),q=definition(t).questions.find(q=>q.questionId===m.question_id)!;
 res.json(await submitLegacyCropScore({examId:b.exam_id,cropId:m.crop_id,userId:actor(req),isAdmin:manager(req),expectedVersion:req.body.version,scores:[{questionNumber:Number(q.displayNumber),score:Number(req.body.score),scoreType:"subjective"}]}));}));
 r.get("/:id/summary",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id));res.json(await summary(b));}));
 r.get("/:id/summary.xlsx",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id)),s=await summary(b);if(s.students.some((p:Row)=>!p.complete))throw err(409,"仍有未完成学生卷，不能导出最终成绩");const rows=s.students.map((p:Row)=>({"流水号":p.serialNumber,"姓名":p.studentName,"学号":String(p.studentNumber||""),...Object.fromEntries(s.questions.map(q=>[q.groupId?(q.title||q.groupId)+"（合并总分）":"第"+q.displayNumber+"题"+(q.historical?"（历史）":""),p.scores[q.displayNumber]])),"总分":p.total}));const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),"最终成绩");res.attachment("final-scores.xlsx");res.send(XLSX.write(book,{type:"buffer",bookType:"xlsx"}));}));
 r.get("/:id/audit",wrap(async(req,res)=>{manage(req);const b=await batchAccess(req,String(req.params.id));res.json({events:await db().all<Row>("SELECT * FROM legacy_pdf_audit WHERE entity_id=? OR entity_id IN(SELECT id FROM legacy_pdf_pages WHERE batch_id=?) OR entity_id IN(SELECT id FROM legacy_pdf_papers WHERE batch_id=?) OR entity_id IN(SELECT r.id FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?) OR entity_id IN(SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=?) ORDER BY id DESC LIMIT 300",b.id,b.id,b.id,b.id,b.id)});}));
 return r;
}
export async function nativePdfTemplate(req:Request,card:any):Promise<string>{
 manage(req);if(card.profile?.preset==="external")throw err(409,"外部卡请上传学校原模板PDF，不能用重新排版的PDF作为定位参考");
 const revision=Number(card.revision||1),family="native:"+card.id;
 const existing=await db().get<Row>("SELECT id FROM legacy_pdf_templates WHERE family_id=? AND revision=?",family,revision);if(existing)return existing.id;
 const {buildLayout}=await import("../../shared/layout"),{createPdf}=await import("../../apps/answer-card/server/pdf"),{objectiveQuestionDefinitions}=await import("../../shared/grading");
 const layout=buildLayout(card),id=uid(),doc=createPdf(card),chunks:Buffer[]=[];
 const bytes=await new Promise<Buffer>((resolve,reject)=>{doc.on("data",(chunk:Buffer)=>chunks.push(chunk));doc.on("error",reject);doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.end();});
 const temp=path.join(root,"tmp",id+".pdf");await writeFile(temp,bytes);const pdf=await storePdf(temp);await rm(temp,{force:true});
 const refs:Row[]=[],pages:any[]=[],identities:any[]=[],questions:any[]=[];
 const normalized=(r:any,p:any)=>({x:r.x/p.width,y:r.y/p.height,width:r.width/p.width,height:r.height/p.height});
 for(let i=0;i<layout.pages.length;i++){const p=layout.pages[i],role="page"+(i+1);refs.push(await renderPage(pdf.path,i+1,path.join(root,"templates",id)));
 pages.push({pageRole:role,widthPt:refs[i].widthPt,heightPt:refs[i].heightPt,sourcePdfPage:i+1,anchorCandidates:p.markers.filter(a=>["top-left","top-right","bottom-left","bottom-right"].includes(a.role)).map(a=>({rect:normalized(a.rect,p)}))});
 const cells=p.elements.filter((e:any)=>e.type==="student_digit").map((e:any)=>({column:e.digitIndex+1,value:String(e.digit),rect:normalized(e.rect,p)}));if(cells.length)identities.push({pageRole:role,fieldType:"omr_digits",length:card.studentInfo.studentNumberDigits,cells});
 }
 if(!identities.length)identities.push({pageRole:pages[0].pageRole,fieldType:"manual"});
 for(const block of card.bodyBlocks){
 if(block.type==="objective"){for(const q of objectiveQuestionDefinitions(block)){let options:any[]=[],role="";
 for(let i=0;i<layout.pages.length;i++){const p=layout.pages[i],elements=p.elements.filter((e:any)=>e.type==="objective_option"&&e.blockId===block.id&&e.questionNumber===q.questionNumber);
 if(elements.length){role=pages[i].pageRole;options=elements.map((e:any)=>({label:e.option,rect:normalized(e.rect,p)}));}}

 questions.push({questionId:"q"+q.questionNumber,displayNumber:String(q.questionNumber),blockId:block.id,gradingType:"objective",pageRole:role,maxScore:q.score,selectionType:q.mode==="single"?"single":"multiple",answer:q.answerKey?.length?q.answerKey:null,options,scoringRule:q.mode!=="single"&&q.scoringRule?{type:"legacy_rule",rule:q.scoringRule}:{type:"exact_match"}});
 }}else for(const q of block.questions||[]){const regions:any[]=[];for(let i=0;i<layout.pages.length;i++){const p=layout.pages[i];for(const e of p.elements.filter((e:any)=>e.type==="subjective_box"&&e.questionId===q.id))regions.push({pageRole:pages[i].pageRole,order:regions.length+1,rect:normalized(e.rect,p)});}
 questions.push({questionId:"q"+q.number,displayNumber:String(q.number),blockId:block.id,gradingType:"teacher_score",maxScore:q.score,answer:null,regions});}
 }
 const def=normalizePdfTemplate({title:card.title,pages,identities,questions}),errors=validatePdfTemplate(def,true);if(errors.length)throw err(409,"原设计卡无法建立扫描模板："+errors.join("；"));
 await db().transactionWithNamedLock("legacy-native-"+card.id,3000,async tx=>{await tx.run("INSERT INTO legacy_pdf_templates(id,family_id,revision,title,status,definition_json,pdf_hash,pdf_path,pages_json,card_id,created_by) VALUES(?,?,?,?,'published',?,?,?,?,?,?)",id,family,revision,def.title,JSON.stringify(def),pdf.hash,pdf.path,JSON.stringify(refs),card.id,actor(req));await audit(tx,"template",id,"freeze_native_card",actor(req),{cardId:card.id,revision},{definition:def});});
 return id;
}
