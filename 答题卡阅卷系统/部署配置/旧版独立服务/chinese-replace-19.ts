import fs from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import assert from "node:assert/strict";
import {getMysqlDb} from "../../源码/server/db/mysql";
import {CardRepository} from "../../源码/server/repositories/CardRepository";
import {normalizePdfTemplate,validatePdfTemplate,objectivePdfScore} from "../../源码/shared/legacyPdf";
import {markScoreMutated} from "../../源码/server/services/examPublishEvents";
const ROOT="/app/data/answer-card",CARD="lp8942fadb3afac8d8",BATCH="3d2fd1ae-39d4-41b1-992b-d09aae6242aa",EXAM=21;
const read=async(n:string)=>JSON.parse(await fs.readFile(ROOT+"/"+n,"utf8"));
const hash=async(p:string)=>createHash("sha256").update(await fs.readFile(p)).digest("hex");
const parsed=(x:any)=>typeof x==="string"?JSON.parse(x):x;
const blockId=(id:string,q:string)=>createHash("sha256").update(id+":"+q).digest("hex").slice(0,32);
async function main(){
 assert.equal(process.env.PROJECTX_MARIADB_HOST,"legacy-old-db");
 assert.equal(process.env.PROJECTX_MARIADB_DATABASE,"school_manager_legacy");
 assert.equal(process.env.PROJECTX_LEGACY_ONLY,"1");
 const old=await read("chinese-replacement-before.json"),input=await read("chinese-replacement-input.json"),stage=await read("chinese-replacement-staged.json"),source=await read("chinese-replacement-answers.json");
 const guard=JSON.parse(await fs.readFile("/guard/health.json","utf8"));assert.ok(!guard.paused&&Date.now()-guard.time<90000,"health guard");
 const def=normalizePdfTemplate(input.definition);assert.deepEqual(validatePdfTemplate(def,true),[]);
 assert.equal(def.questions.length,19);assert.equal(def.questions.reduce((n,q)=>n+q.maxScore,0),120);
 assert.equal(stage.failed.length,0);assert.equal(stage.pages.length,86);
 assert.equal(await hash(input.pdf_path),input.pdf_hash);assert.equal(await hash(old.batches[0].pdf_path),old.batches[0].pdf_hash);
 const answers=source.answers.map((a:any)=>({...a,answerText:a.answerText.replace(/^本题满分按答题卡（[^）]+）；文件原文分值供核对。/,"")}));
 const keys:any={};for(const q of def.questions.filter(q=>q.gradingType==="objective")){
  const ref=answers.find((a:any)=>a.questionNumber===Number(q.displayNumber));assert.ok(ref&&/^[A-E]+$/.test(ref.answerText));keys[q.questionId]=ref.answerText.split("");
 }
 assert.equal(Object.keys(keys).length,10);assert.deepEqual(keys.q8,["B","E"]);
 for(const p of stage.pages)assert.equal(await hash(old.pages.find((x:any)=>x.id===p.id).raw_path),p.rawHash,"raw image changed");
 const db=getMysqlDb(),repo=new CardRepository(db),card=await repo.findById(CARD);assert.ok(card);
 const result=await db.transactionWithNamedLock("legacy-batch-"+BATCH,5000,async tx=>{
  const exam=await tx.get<any>("SELECT * FROM exams WHERE id=? FOR UPDATE",EXAM);assert.equal(exam.card_id,CARD);
  const batch=await tx.get<any>("SELECT * FROM legacy_pdf_batches WHERE id=? FOR UPDATE",BATCH);assert.equal(batch.template_id,old.batches[0].template_id);assert.equal(batch.status,"ready");
  const existing=await tx.get<any>("SELECT id FROM legacy_pdf_templates WHERE id=?",input.id);assert.ok(!existing,"replacement already exists");
  const job=await tx.get<any>("SELECT * FROM legacy_pdf_jobs WHERE batch_id=? FOR UPDATE",BATCH);assert.ok(!["running","queued"].includes(job.status));
  const papers=await tx.all<any>("SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY sheet_no FOR UPDATE",BATCH);
  const pages=await tx.all<any>("SELECT * FROM legacy_pdf_pages WHERE batch_id=? ORDER BY source_page FOR UPDATE",BATCH);
  const results=await tx.all<any>("SELECT r.* FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=? ORDER BY r.id FOR UPDATE",BATCH);
  assert.deepEqual(papers.map(p=>[p.id,p.version,p.student_id,p.identity_status,p.ownership_confirmed,p.auto_identity]),old.papers.map((p:any)=>[p.id,p.version,p.student_id,p.identity_status,p.ownership_confirmed,p.auto_identity]));
  assert.deepEqual(pages.map(p=>[p.id,p.version,p.paper_id,p.page_role,p.alignment_json,p.manual_json]),old.pages.map((p:any)=>[p.id,p.version,p.paper_id,p.page_role,p.alignment_json,p.manual_json]));
  assert.deepEqual(results.map(r=>[r.id,r.version,r.final_source,r.final_value]),old.results.map((r:any)=>[r.id,r.version,r.final_source,r.final_value]));
  for(const table of ["legacy_pdf_marks","review_assignments","question_scores","student_scores"]){
   const rows=table==="legacy_pdf_marks"?await tx.all<any>("SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=?",BATCH):await tx.all<any>("SELECT * FROM "+table+" WHERE exam_id=?",EXAM);
   assert.equal(rows.length,0,"existing scores/tasks require explicit migration: "+table);
  }
  const template=await tx.get<any>("SELECT * FROM legacy_pdf_templates WHERE id=? FOR UPDATE",batch.template_id);
  const max=await tx.get<any>("SELECT MAX(revision) rev FROM legacy_pdf_templates WHERE family_id=?",template.family_id);assert.equal(max.rev,1);
  const beforeCard=await tx.get<any>("SELECT revision FROM answer_cards WHERE id=? FOR UPDATE",CARD);assert.equal(beforeCard.revision,old.cards[0].revision);
  const audit=async(type:string,id:string,action:string,b:any,a:any)=>tx.run("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json) VALUES(?,?,?,1,?,?)",type,id,action,JSON.stringify(b),JSON.stringify({...a,runId:input.id,algorithmVersion:stage.algorithmVersion}));
  await tx.run("INSERT INTO legacy_pdf_templates(id,family_id,revision,title,status,definition_json,pdf_hash,pdf_path,pages_json,card_id,created_by) VALUES(?,?,2,?,'published',?,?,?,?,?,1)",input.id,template.family_id,def.title,JSON.stringify(def),input.pdf_hash,input.pdf_path,JSON.stringify(input.pages),CARD);
  card.title=def.title;card.paper.orientation="landscape";card.paper.size="A3";card.sided="double";card.studentInfo.studentNumberDigits=6;
  card.bodyBlocks=def.questions.map(q=>q.gradingType==="objective"?{id:blockId(input.id,q.questionId),type:"objective",title:"第"+q.displayNumber+"题",questionStart:Number(q.displayNumber),questionCount:1,optionCount:q.options?.length||4,mode:q.selectionType||"single",scorePerQuestion:q.maxScore,density:"compact",answerKey:{[Number(q.displayNumber)]:keys[q.questionId]}}:{id:blockId(input.id,q.questionId),type:"subjective",title:"第"+q.displayNumber+"题",questions:[{id:randomUUID(),number:Number(q.displayNumber),score:q.maxScore,style:"plain_subjective",kind:"plain_box",minHeightMm:20}]}) as any;
  const cardRevision=await repo.updateCardInTx(card,tx);
  await tx.run("UPDATE legacy_pdf_batches SET template_id=?,answer_key_json=NULL,status='ready',error=NULL WHERE id=?",input.id,BATCH);
  await tx.run("INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,1) ON DUPLICATE KEY UPDATE answers_json=VALUES(answers_json),updated_by=1,updated_at=CURRENT_TIMESTAMP",EXAM,JSON.stringify(keys));
  for(const a of answers)await tx.run("UPDATE exam_answer_keys SET answer_text=?,updated_by=1,updated_at=CURRENT_TIMESTAMP WHERE exam_id=? AND question_number=?",a.answerText,EXAM,a.questionNumber);
  let protectedCount=0,protectedConflicts=0,automaticChanges=0,obsolete=0,uncertain=0;
  const objective=def.questions.filter(q=>q.gradingType==="objective");
  for(const page of pages){
   const staged=stage.pages.find((p:any)=>p.id===page.id);
   const rec={...staged.recognition,identities:parsed(page.recognition_json)?.identities||[]};
   await tx.run("UPDATE legacy_pdf_pages SET aligned_path=?,alignment_json=?,recognition_json=?,status='recognized',version=version+1 WHERE id=?",staged.aligned_path,JSON.stringify(staged.alignment),JSON.stringify(rec),page.id);
   await audit("page",page.id,"replace_authoritative_pdf",{templateId:template.id,alignedPath:page.aligned_path,alignment:parsed(page.alignment_json),version:page.version},{templateId:input.id,alignedPath:staged.aligned_path,alignment:staged.alignment,version:Number(page.version)+1});
  }
  for(const paper of papers){
   const recognized=stage.pages.filter((p:any)=>pages.find(x=>x.id===p.id)?.paper_id===paper.id).flatMap((p:any)=>p.recognition.questions);
   assert.equal(recognized.length,10);
   for(const q of objective){
    const rec=recognized.find((r:any)=>r.questionId===q.questionId);assert.ok(rec);
    const prior=results.find(r=>r.paper_id===paper.id&&r.question_id===q.questionId);
    const protect=prior&&prior.final_source!=="auto";
    const final=protect?parsed(prior.final_value):rec.value,source=protect?prior.final_source:"auto";
    assert.ok(Array.isArray(final)&&final.every(v=>q.options?.some(o=>o.label===v)),"invalid protected answer");
    const conflict=protect&&JSON.stringify(final.slice().sort())!==JSON.stringify(rec.value.slice().sort());
    if(protect)protectedCount++;if(conflict)protectedConflicts++;
    if(!protect&&prior&&JSON.stringify(final)!==prior.final_value)automaticChanges++;
    if(rec.status==="ambiguous")uncertain++;
    const status=protect?prior.status:"confirmed",score=status==="confirmed"?objectivePdfScore({...q,answer:keys[q.questionId]},final):null;
    const id=prior?.id||randomUUID();
    if(prior)await tx.run("UPDATE legacy_pdf_results SET auto_value=?,final_value=?,status=?,confidence=?,score=?,final_source=?,recognizer_version=?,version=version+1 WHERE id=?",JSON.stringify(rec),JSON.stringify(final),status,rec.confidence,score,source,stage.algorithmVersion,id);
    else await tx.run("INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value,final_value,status,confidence,score,final_source,recognizer_version,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)",id,paper.id,q.questionId,JSON.stringify(rec),JSON.stringify(final),status,rec.confidence,score,source,stage.algorithmVersion);
    await audit("result",id,"replace_authoritative_pdf",prior||null,{templateId:input.id,questionId:q.questionId,value:final,auto:rec,source,status,score,protected:!!protect,protectedConflict:!!conflict});
   }
   for(const r of results.filter(r=>r.paper_id===paper.id&&!objective.some(q=>q.questionId===r.question_id))){
    await audit("result",r.id,"archive_obsolete_layout_result",r,{templateId:input.id,removed:true});
    await tx.run("DELETE FROM legacy_pdf_results WHERE id=?",r.id);obsolete++;
   }
   await tx.run("UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?",paper.id);
  }
  await markScoreMutated(tx,EXAM,1,"answer_edit");
  await audit("batch",BATCH,"replace_authoritative_pdf",{templateId:template.id,pdfHash:batch.pdf_hash,objectiveResults:results.length},{templateId:input.id,revision:2,logicalCardId:CARD,cardRevision,pdfHash:batch.pdf_hash,sourceTemplateHash:input.pdf_hash,objectiveResults:430,protectedCount,protectedConflicts,automaticChanges,obsolete,uncertain});
  await audit("template",input.id,"replace_authoritative_pdf",{templateId:template.id,cardId:CARD},{revision:2,cardId:CARD,pdfHash:input.pdf_hash,questions:19,totalScore:120});
  return {batchId:BATCH,examId:EXAM,cardId:CARD,templateId:input.id,templateRevision:2,cardRevision,questions:19,totalScore:120,papers:papers.length,pages:pages.length,results:430,protectedCount,protectedConflicts,automaticChanges,obsolete,uncertain,identityAndPageOwnershipPreserved:true,originalScanHash:batch.pdf_hash,templateHash:input.pdf_hash,algorithmVersion:stage.algorithmVersion};
 });
 await fs.writeFile(ROOT+"/chinese-replacement-report.json",JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify(result));process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
