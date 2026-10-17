// Isolated tests: no real DB adapter, filesystem writes, app startup, or native services.
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {createRequire} from "node:module";
import * as groups from "../源码/server/services/LegacyReviewGroupScoreService.ts";
process.env.PROJECTX_LEGACY_ONLY="1";
const require=createRequire(import.meta.url);
const ts=require(process.env.LEGACY_TEST_TYPESCRIPT || "/home/ecs-user/school-manager-answer-card/answer-card/node_modules/typescript");
const plain=v=>JSON.parse(JSON.stringify(v));
const fail=()=>{throw new Error("A live dependency was invoked by an isolated test");};
const questions=[40,...Array.from({length:15},(_,i)=>46+i),61].map(n=>({questionId:"q"+n,displayNumber:String(n),gradingType:n===40?"objective":"teacher_score",maxScore:n===40?10:n===61?5:2,answer:null}));
const def={questions,pages:[],identities:[]};
const configs=Object.entries(groups.LEGACY_REVIEW_GROUP_MEMBERS).map(([group_id,numbers])=>({exam_id:22,group_id,title:group_id,questions:[...numbers],questions_json:JSON.stringify(numbers),max_score:10,mode:"active"}));
const groupRows=(values=[8,9])=>configs.map((c,i)=>({exam_id:22,serial_no:7,group_id:c.group_id,paper_id:"paper",score:values[i],max_score:10,status:values[i]==null?"ready":"reviewed",version:1,source:"teacher",graded_by:3,graded_at:null,claimed_by:null,claimed_at:null,input_signature:null}));
const results=[{paper_id:"paper",question_id:"q40",score:10,status:"confirmed",kind:"objective",serial_no:7}];
const marks=questions.filter(q=>q.gradingType==="teacher_score").map(q=>({paper_id:"paper",question_id:q.questionId,score:q.displayNumber==="61"?5:1,status:"reviewed",kind:"teacher_score",serial_no:7}));
const calculate=(overrides={})=>groups.effectiveLegacyPaperScores({examId:22,paperId:"paper",serialNumber:7,def,results,marks,groups:configs,groupScores:groupRows(),...overrides});
test("protected service never queries the legacy group tables",async()=>{
 process.env.PROJECTX_LEGACY_ONLY="0";
 try {
  assert.deepEqual(await groups.readReviewGroups({all:fail},22),[]);
  assert.deepEqual(await groups.readReviewGroupScoreContext({all:fail},22),{groups:[],scores:[]});
  assert.equal(await groups.readLegacyReviewGroupExport({all:fail},22),null);
 } finally { process.env.PROJECTX_LEGACY_ONLY="1"; }
});
test("group totals replace all children once; outside subjective/objective remain",()=>{
 const result=calculate();assert.equal(result.total,32);assert.equal(result.subjective,22);
 assert.equal(result.subjectiveRequired,3);assert.equal(result.subjectiveDone,3);
 assert.equal(result.historicalQuestionNumbers.length,15);
 assert.equal(result.historicalScores["46"],1);assert.equal(result.scores["english-46-55"],8);
});
test("nullable total is incomplete despite every old child being reviewed",()=>{
 for(const values of [[null,9],[8,null],[null,null]]){const r=calculate({groupScores:groupRows(values)});assert.equal(r.total,null);assert.equal(r.subjectiveComplete,false);}
});
test("zero is a reviewed total, never null",()=>{
 const r=calculate({groupScores:groupRows([0,0])});assert.equal(r.total,15);assert.equal(r.subjectiveDone,3);
 assert.equal(r.scores["english-46-55"],0);
});
test("ready nonnull and invalid totals cannot publish",()=>{
 for(const row of [{status:"ready"},{score:NaN},{score:Infinity},{score:11},{score:-1}]){
  const records=groupRows();Object.assign(records[0],row);assert.equal(calculate({groupScores:records}).total,null);
 }
});
test("partial old children never initialize a group implicitly",()=>{
 assert.equal(calculate({marks:marks.slice(0,3),groupScores:[]}).total,null);
});
test("fully old-complete existing_sum totals remain valid",()=>{
 const rows=groupRows([10,5]).map(s=>({...s,source:"existing_sum"}));assert.equal(calculate({groupScores:rows}).total,30);
});
test("readonly and draft rollback honor persisted totals",()=>{
 for(const mode of ["readonly","draft"]){const gs=configs.map(g=>({...g,mode}));assert.equal(calculate({groups:gs}).total,32);}
});
test("draft without totals retains old question workflow",()=>{
 assert.equal(calculate({groups:configs.map(g=>({...g,mode:"draft"})),groupScores:[]}).total,30);
});
test("other exams, wrong serial, wrong paper, wrong exam and unrelated records",()=>{
 assert.equal(calculate({examId:21}).total,30);
 for(const bad of [{serial_no:8},{paper_id:"other"},{exam_id:21}]){
  const rows=groupRows();Object.assign(rows[0],bad);assert.equal(calculate({groupScores:rows}).total,null);
 }
 assert.equal(calculate({serialNumber:null}).total,null);
 const stale={question_id:"orphan",score:999,status:"confirmed"};assert.equal(calculate({results:[...results,stale]}).total,32);
});
test("aggregation leaves child marks and input arrays untouched",()=>{
 const before=JSON.stringify({marks,results,configs});calculate();assert.equal(JSON.stringify({marks,results,configs}),before);
});
test("history columns are labeled and groups appended once",()=>{
 const columns=groups.legacyGroupedQuestionColumns(questions.map(q=>({number:q.displayNumber,kind:q.gradingType,maxScore:q.maxScore})),configs);
 assert.equal(columns.filter(q=>q.historical).length,15);assert.equal(columns.filter(q=>q.groupId).length,2);
 assert.match(columns.find(q=>q.number==="46").title,/历史/);
});
test("only approved exam/id/membership configurations are accepted",()=>{
 assert.equal(groups.normalizeLegacyReviewGroup({...configs[0],exam_id:21}),null);
 assert.equal(groups.normalizeLegacyReviewGroup({...configs[0],group_id:"another"}),null);
 assert.throws(()=>groups.normalizeLegacyReviewGroup({...configs[0],questions_json:"[46]"}),/membership/);
});
test("schema initializer emits only the two requested DDL statements",async()=>{
 const sql=[];await groups.ensureReviewGroupSchema({exec:async s=>sql.push(s)});
 assert.equal(sql.length,2);assert(sql.every(s=>s.startsWith("CREATE TABLE IF NOT EXISTS legacy_review_group")));
 assert(sql[0].includes("PRIMARY KEY(exam_id,group_id)"));assert(sql[1].includes("PRIMARY KEY(exam_id,serial_no,group_id)"));
});
test("active reader and transactional child guard include transition/readonly",async()=>{
 for(const mode of ["active","transition","readonly","draft"]){
  const queries=[],db={all:async sql=>{queries.push(sql);return configs.map(g=>({...g,mode}));}};
  assert.equal((await groups.readActiveReviewGroups(db,22)).length,mode==="draft"?0:2);
  if(mode==="draft")await groups.assertLegacyQuestionNotGrouped(db,22,46);
  else await assert.rejects(groups.assertLegacyQuestionNotGrouped(db,22,46),e=>e.status===409&&e.message==="刷新合并阅卷");
  assert(queries.at(-1).endsWith("FOR UPDATE"));
  await groups.assertLegacyQuestionNotGrouped(db,22,61);
 }
 await groups.assertLegacyQuestionNotGrouped({all:fail},21,46);
});
test("read context preserves stored totals after config rollback and joins full serial identity",async()=>{
 const queries=[],context=await groups.readReviewGroupScoreContext({all:async(sql,...args)=>{queries.push({sql,args});return sql.includes("FROM legacy_review_groups")?[]:groupRows();}},22,["paper"],true);
 assert.equal(context.groups.length,2);assert(context.groups.every(g=>g.mode==="draft"));assert.equal(calculate({groups:context.groups,groupScores:context.scores}).total,32);
 assert(queries[1].sql.includes("s.serial_no=g.serial_no"));assert(queries[1].sql.includes("s.paper_id=g.paper_id"));assert(queries[1].sql.endsWith("FOR UPDATE"));
 assert.deepEqual(queries[1].args,[22,"paper"]);
 assert.deepEqual(await groups.readReviewGroupScoreContext({all:fail},21),{groups:[],scores:[]});
});

// Actual service source runs in a VM; imports are replaced with harmless mocks.
// This validates orchestration, SQL/transaction placement, and publication guards without opening a DB.
async function loadService(relative,overrides={}){
 const source=await readFile(new URL(relative,import.meta.url),"utf8");
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const ast=ts.createSourceFile("service.js",js,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const names=new Map();
 for(const stmt of ast.statements)if(ts.isImportDeclaration(stmt)){
  const spec=stmt.moduleSpecifier.text,list=[];
  if(stmt.importClause?.name)list.push("default");
  if(stmt.importClause?.namedBindings&&ts.isNamedImports(stmt.importClause.namedBindings))
   for(const el of stmt.importClause.namedBindings.elements)list.push((el.propertyName||el.name).text);
  names.set(spec,list);
 }
 const context=vm.createContext({console,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,URL});
 const service=new vm.SourceTextModule(js,{context,identifier:new URL(relative,import.meta.url).href,initializeImportMeta:meta=>{meta.url=new URL(relative,import.meta.url).href;}});
 await service.link(async spec=>{
  let values={};
  if(spec==="node:module")values={createRequire:()=>()=>({})};
  else if(spec.startsWith("node:"))values=await import(spec);
  else if(spec.includes("LegacyReviewGroupScoreService"))values=groups;
  else values={getMysqlDb:fail,normalizePdfTemplate:d=>d,syncSerialScores:async()=>{},databaseTimestamp:()=>"2026-10-14 00:00:00",createExamProgressReader:fn=>fn};
  Object.assign(values,overrides[spec]||{});
  const exports=names.get(spec)||[];
  return new vm.SyntheticModule(exports,function(){for(const name of exports)this.setExport(name,values[name]??(()=>{}));},{context});
 });
 await service.evaluate();return service.namespace;
}
function adapter({mode="active",values=[8,9],oldMarks=marks,cache=32,running=false}={}){
 let inTx=false;
 const calls=[],writes=[],paper={id:"paper",exam_id:22,template_id:"template",batch_id:"batch",student_id:99,identity_status:"confirmed",ownership_confirmed:1,serialNumber:7,sheet_no:1};
 const ledger=[...results,...oldMarks].map(r=>({...r,exam_id:22}));
 const db={
  dialect:"mariadb",calls,writes,
  get:async(sql,...args)=>{
   calls.push({kind:"get",sql,args,inTx});
   if(sql.includes("FROM legacy_pdf_templates"))return {id:"template",definition_json:JSON.stringify(def)};
   if(sql.includes("FROM legacy_pdf_exam_keys"))return {answers_json:"{}"};
   if(sql.includes("FROM legacy_pdf_marks m JOIN"))return {...oldMarks[0],id:"mark",crop_id:"crop",paper_id:"paper",batch_id:"batch",student_id:99,exam_id:22,template_id:"template"};
   if(sql.includes("FROM legacy_pdf_marks WHERE id"))return {...oldMarks[0],id:"mark",version:1};
   if(sql.includes("FROM answer_block_crops"))return {id:"crop",claimed_by:3,reviewer_id:3,review_round:1};
   if(sql.includes("FROM legacy_paper_serials"))return {exam_id:22,serial_no:7};
   if(sql.includes("FROM student_scores"))return {total_score:cache};
   if(sql.includes("legacy_pdf_jobs")||sql.includes("legacy_pdf_stage_jobs"))return running?{id:"job"}:null;
   if(sql.includes("FROM legacy_pdf_papers p JOIN"))return paper;
   return null;
  },
  all:async(sql,...args)=>{
   calls.push({kind:"all",sql,args,inTx});
   if(sql.includes("FROM legacy_review_groups"))return configs.map(g=>({...g,mode}));
   if(sql.includes("FROM legacy_review_group_scores"))return groupRows(values);
   if(sql.includes("SELECT DISTINCT t.id")||sql.includes("SELECT id,definition_json"))return [{id:"template",definition_json:JSON.stringify(def)}];
   if(sql.includes("legacy_pdf_jobs")||sql.includes("legacy_pdf_stage_jobs"))return running?[{batch_id:"batch"}]:[];
   if(sql.includes("FROM legacy_pdf_batches"))return [{id:"batch",exam_id:22,template_id:"template",original_name:"fixture.pdf"}];
   if(sql.includes("FROM legacy_pdf_papers"))return [paper];
   if(sql.includes("FROM legacy_pdf_results"))return results;
   if(sql.includes("FROM legacy_pdf_marks"))return oldMarks;
   if(sql.includes("FROM legacy_serial_question_scores"))return sql.includes("kind='objective'")?results:sql.includes("kind='teacher_score'")?oldMarks:ledger;
   if(sql.includes("legacy_pdf_jobs")||sql.includes("legacy_pdf_stage_jobs"))return running?[{batch_id:"batch"}]:[];
   return [];
  },
  run:async(sql,...args)=>{calls.push({kind:"run",sql,args,inTx});writes.push({sql,args});return {changes:1,lastInsertRowid:0};},
  exec:fail,
  transaction:async fn=>{assert.equal(inTx,false);inTx=true;try{return await fn(db);}finally{inTx=false;}},
  transactionWithNamedLock:fail
 };
 return db;
}
const serial=await loadService("../源码/server/services/LegacySerialScoreService.ts");
const legacy=await loadService("../源码/server/services/LegacyPdfService.ts",{"./LegacySerialScoreService":{syncSerialScores:serial.syncSerialScores}});
const progress=await loadService("../源码/server/services/ExamPdfProgressService.ts");
test("actual recompute updates effective cache and unchanged child history; never splits groups",async()=>{
 const db=adapter();assert.equal(await db.transaction(tx=>legacy.recomputeLegacyPaperTotals(tx,"paper",3)),32);
 assert.deepEqual(db.writes.find(w=>w.sql.startsWith("UPDATE student_scores")).args.slice(0,3),[10,22,32]);
 assert(db.writes.every(w=>!w.sql.includes("legacy_review_group_scores")&&!w.sql.includes("legacy_pdf_marks")&&!w.sql.includes("INSERT INTO question_scores")));
 const insert=db.writes.find(w=>w.sql.startsWith("INSERT INTO legacy_serial_question_scores"));
 assert(!insert.args.includes("english-46-55"));
 const rows=Array.from({length:questions.length},(_,i)=>insert.args.slice(i*11,(i+1)*11));
 assert.equal(rows.find(r=>r[2]==="46")[6],1);assert.equal(rows.find(r=>r[2]==="56")[6],1);
 assert(db.calls.find(c=>c.sql.includes("FROM legacy_review_groups")).sql.endsWith("FOR UPDATE"));
});
test("actual recompute stays incomplete when group missing despite complete child marks",async()=>{
 const db=adapter({values:[null,9]});assert.equal(await legacy.recomputeLegacyPaperTotals(db,"paper",3),null);
 assert.deepEqual(db.writes.find(w=>w.sql.startsWith("UPDATE student_scores")).args.slice(0,3),[10,null,null]);
});
test("actual objective recompute and readonly rollback preserve group values",async()=>{
 for(const mode of ["active","readonly","draft"]){const db=adapter({mode});assert.equal(await legacy.recomputeLegacyPaperTotals(db,"paper",3),32);}
});
test("actual crop submit rejects before writes/reused return, inside locked transaction",async()=>{
 for(const mode of ["active","transition","readonly"]){
  const db=adapter({mode});await assert.rejects(legacy.submitLegacyCropScore({examId:22,cropId:"crop",userId:3,isAdmin:true,blockTotalScore:99},db),e=>e.status===409&&e.message==="刷新合并阅卷");
  const config=db.calls.find(c=>c.sql.includes("FROM legacy_review_groups"));assert.equal(config.inTx,true);assert(config.sql.endsWith("FOR UPDATE"));assert.equal(db.writes.length,0);
 }
 const db=adapter({mode:"draft",cache:30});assert.equal((await legacy.submitLegacyCropScore({examId:22,cropId:"crop",userId:3,isAdmin:true,blockTotalScore:1},db)).reused,true);
});
test("actual batch and exam summaries use identical group totals/history",async()=>{
 const db=adapter();const batch=await legacy.legacyBatchScoreSummary({id:"batch",exam_id:22,template_id:"template"},db);
 const exam=await progress.examQuestionSummary(22,{},db);
 assert.equal(batch.students[0].total,32);assert.equal(exam.rows[0].totalScore,32);
 assert.deepEqual(plain(batch.students[0].groupScores),plain(exam.rows[0].groupScores));
 assert.equal(batch.questions.filter(q=>q.groupId).length,2);assert.equal(exam.questions.filter(q=>q.historical).length,15);
 const missing=adapter({values:[null,9]});
 assert.equal((await legacy.legacyBatchScoreSummary({id:"batch",exam_id:22,template_id:"template"},missing)).students[0].complete,false);
 assert.equal((await progress.examQuestionSummary(22,{},missing)).rows[0].totalScore,null);
});
test("actual summaries block both objective job queues during reprocessing",async()=>{
 const db=adapter({running:true});
 assert.equal((await legacy.legacyBatchScoreSummary({id:"batch",exam_id:22,template_id:"template"},db)).students[0].complete,false);
 assert.equal((await progress.examQuestionSummary(22,{},db)).rows[0].totalScore,null);
});
test("publication validates live groups even when stale cache is nonnull",async()=>{
 await legacy.assertLegacyScoresReady(adapter(),22);
 await assert.rejects(legacy.assertLegacyScoresReady(adapter({values:[null,9],cache:30}),22),e=>e.status===409);
 await assert.rejects(legacy.assertLegacyScoresReady(adapter({cache:30}),22),e=>e.status===409);
});
test("export overlay delivers formal group totals and labeled historical children; zero preserved",async()=>{
 const data=await groups.readLegacyReviewGroupExport(adapter({values:[0,9]}),22);
 assert.equal(data.rows[0].scores["english-46-55"],0);assert.equal(data.rows[0].total,24);
 assert.equal(data.questions.filter(q=>q.historical).length,15);assert.equal(data.questions.filter(q=>q.groupId).length,2);
 assert.equal(await groups.readLegacyReviewGroupExport({all:fail},21),null);
});

test("draft config row lock makes activation wait for old submission commit",async()=>{
 let unlock,locked=false;const released=new Promise(resolve=>{unlock=resolve;});
 const oldTx={all:async sql=>{assert(sql.endsWith("FOR UPDATE"));locked=true;return configs.map(g=>({...g,mode:"draft"}));}};
 await groups.assertLegacyQuestionNotGrouped(oldTx,22,46);
 let activated=false;
 const activation=(async()=>{if(locked)await released;activated=true;})();
 await Promise.resolve();assert.equal(activated,false);
 locked=false;unlock();await activation;assert.equal(activated,true);
});
