/**
 * Isolated regression: real in-memory SQLite SQL + TypeScript VM modules.
 * Does not import the application DB, start a server, activate a group, or touch production data.
 * Run: node scripts/verify-legacy-review-groups.cjs
 * Override REVIEW_GROUP_TEST_MODULES for a different existing dependency directory.
 */
const assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises");
const path=require("node:path"),os=require("node:os"),vm=require("node:vm"),crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite"),{performance}=require("node:perf_hooks");
const root=path.resolve(__dirname,".."),dep=process.env.REVIEW_GROUP_TEST_MODULES || "/home/ecs-user/school-manager-answer-card/answer-card/node_modules";
const ts=require(path.join(dep,"typescript")),sharp=require(path.join(dep,"sharp"));
const sha=x=>crypto.createHash("sha256").update(x).digest("hex");
const block=(t,q)=>sha(t+":"+q).slice(0,32);
let db,service,aiService,scoreService,fixture,failTotals=false,authAllowed=true,log=[],locks=new Map(),count=0;
process.env.PROJECTX_LEGACY_ONLY="1";
function load(rel,stubs){
 const filename=path.join(root,rel),source=fs.readFileSync(filename,"utf8");
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const mod={exports:{}};
 vm.runInNewContext(js,{module:mod,exports:mod.exports,Buffer,process,console,
   require:name=>Object.hasOwn(stubs,name)?stubs[name]:name.startsWith("node:")?require(name):(()=>{throw Error("Unexpected dependency "+name)})()},
   {filename});
 return mod.exports;
}
function setup(){
 db=new DatabaseSync(":memory:");
 db.exec(`
 CREATE TABLE legacy_review_groups(exam_id INTEGER,group_id TEXT,title TEXT,questions_json TEXT,max_score REAL,mode TEXT,PRIMARY KEY(exam_id,group_id));
 CREATE TABLE legacy_review_group_scores(exam_id INTEGER,serial_no INTEGER,group_id TEXT,paper_id TEXT,score REAL,max_score REAL,status TEXT,version INTEGER,graded_by INTEGER,graded_at TEXT,source TEXT,claimed_by INTEGER,claimed_at TEXT,input_signature TEXT,PRIMARY KEY(exam_id,serial_no,group_id));
 CREATE TABLE legacy_review_group_requests(exam_id INTEGER,serial_no INTEGER,group_id TEXT,request_id TEXT,actor_id INTEGER,payload_hash TEXT,response_json TEXT,PRIMARY KEY(exam_id,serial_no,group_id,request_id));
 CREATE TABLE legacy_pdf_templates(id TEXT PRIMARY KEY,definition_json TEXT);
 CREATE TABLE legacy_pdf_batches(id TEXT PRIMARY KEY,exam_id INTEGER,template_id TEXT);
 CREATE TABLE legacy_pdf_papers(id TEXT PRIMARY KEY,batch_id TEXT,student_id INTEGER,identity_status TEXT,ownership_confirmed INTEGER);
 CREATE TABLE legacy_paper_serials(exam_id INTEGER,serial_no INTEGER,paper_id TEXT,PRIMARY KEY(exam_id,serial_no));
 CREATE TABLE legacy_pdf_pages(id TEXT PRIMARY KEY,paper_id TEXT,page_role TEXT,aligned_path TEXT,version INTEGER,status TEXT);
 CREATE TABLE answer_block_crops(id TEXT PRIMARY KEY,exam_id INTEGER,block_id TEXT,source_record_id TEXT,source_type TEXT,student_id INTEGER,claimed_by INTEGER,status TEXT,review_round INTEGER,reviewer_id INTEGER,reviewed_at TEXT);
 CREATE TABLE legacy_pdf_marks(id TEXT PRIMARY KEY,paper_id TEXT,question_id TEXT,crop_id TEXT,score REAL,status TEXT,version INTEGER);
 CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);
 CREATE TABLE review_assignments(id INTEGER PRIMARY KEY,exam_id INTEGER,block_id TEXT,teacher_id INTEGER,student_count INTEGER,assigned_student_ids TEXT,auto_assigned INTEGER,created_at TEXT);
 CREATE TABLE exam_answer_keys(exam_id INTEGER,question_number INTEGER,answer_text TEXT,PRIMARY KEY(exam_id,question_number));
 CREATE TABLE legacy_pdf_audit(id INTEGER PRIMARY KEY,entity_type TEXT,entity_id TEXT,action TEXT,operator_id INTEGER,before_json TEXT,after_json TEXT);
 CREATE TABLE legacy_ai_score_suggestions(id TEXT PRIMARY KEY,exam_id INTEGER,paper_id TEXT,serial_no INTEGER,crop_id TEXT,question_number INTEGER,status TEXT,score REAL,max_score REAL,answer_text TEXT,reason TEXT,rubric_version TEXT,rubric_hash TEXT,input_json TEXT,created_at TEXT);
 CREATE TABLE legacy_ai_score_adoptions(id INTEGER PRIMARY KEY,suggestion_id TEXT,actor_id INTEGER,crop_id TEXT);
 `);
 log=[];
}
const clean=sql=>sql.replace(/ FOR UPDATE/g,"");
const adapter={
 dialect:"mariadb",
 async get(sql,...params){log.push({sql,params});return db.prepare(clean(sql)).get(...params)||null;},
 async all(sql,...params){log.push({sql,params});return db.prepare(clean(sql)).all(...params);},
 async run(sql,...params){
  log.push({sql,params});
  if(sql.includes("ON DUPLICATE KEY UPDATE")) sql=sql.replace(/ON DUPLICATE KEY UPDATE[\s\S]*$/,"ON CONFLICT(exam_id,serial_no,group_id) DO UPDATE SET claimed_by=excluded.claimed_by,claimed_at=excluded.claimed_at,input_signature=excluded.input_signature");
  const r=db.prepare(clean(sql)).run(...params);return {changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)};
 },
 async exec(){throw Error("Unexpected DDL: tests initialize their own memory schema");},
 async transaction(fn){db.exec("BEGIN");try{const r=await fn(adapter);db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}},
 async transactionWithNamedLock(name,wait,fn){
  const prior=locks.get(name)||Promise.resolve();
  const current=prior.catch(()=>{}).then(()=>adapter.transaction(fn));locks.set(name,current);return current;
 }
};
const req=(extra={})=>({method:"GET",params:{examId:"22",groupId:"english-46-55",serial:"1",...extra.params},
 user:{id:9,role_id:2,role_name:"teacher",teacher_role:null,...extra.user},body:extra.body||{},query:extra.query||{},...extra,
 params:{examId:"22",groupId:"english-46-55",serial:"1",...extra.params}});
function addPaper(serial){
 const paper="paper-"+serial,student=1000+serial;
 db.prepare("INSERT INTO legacy_pdf_papers VALUES(?,?,?,?,?)").run(paper,"batch",student,"confirmed",1);
 db.prepare("INSERT INTO legacy_paper_serials VALUES(?,?,?)").run(22,serial,paper);
 for(const role of ["front","back"]) db.prepare("INSERT INTO legacy_pdf_pages VALUES(?,?,?,?,?,?)").run(paper+"-"+role,paper,role,path.join(fixture,role+".png"),1,"recognized");
 for(let n=46;n<=60;n++){
  const crop=paper+"-q"+n;
  db.prepare("INSERT INTO answer_block_crops VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crop,22,block("template","q"+n),paper,"legacy_pdf",student,null,"reviewed",1,8,"2026-10-01 00:00:00");
  db.prepare("INSERT INTO legacy_pdf_marks VALUES(?,?,?,?,?,?,?)").run(crop+"-mark",paper,"q"+n,crop,n<=55?0.5:1,"reviewed",1);
 }
}
function seed(n=3){
 setup();failTotals=false;authAllowed=true;
 const def={format:"legacy-pdf-template-v1",title:"English",pages:[{pageRole:"front"},{pageRole:"back"}],identities:[{pageRole:"front",fieldType:"name_ocr",rect:{x:0.1,y:0.02,width:0.3,height:0.04}}],
 questions:Array.from({length:15},(_,i)=>({questionId:"q"+(46+i),displayNumber:String(46+i),gradingType:"teacher_score",maxScore:i<10?1:2,
  regions:[{pageRole:i<10?"front":"back",order:1,rect:{x:0.1,y:0.2+(i<10?i:i-10)*0.035,width:0.7,height:0.03}}]}))};
 const raw=JSON.stringify(def);
 db.prepare("INSERT INTO legacy_pdf_templates VALUES(?,?)").run("template",raw);
 db.prepare("INSERT INTO legacy_pdf_batches VALUES(?,?,?)").run("batch",22,"template");
 db.prepare("INSERT INTO users VALUES(?,?)").run(8,"Reviewer");
 for(const [id,start,length] of [["english-46-55",46,10],["english-56-60",56,5]]){
  db.prepare("INSERT INTO legacy_review_groups VALUES(?,?,?,?,?,?)").run(22,id,id,JSON.stringify(Array.from({length},(_,i)=>start+i)),10,"active");
 }
 for(let q=46;q<=60;q++){
  db.prepare("INSERT INTO review_assignments VALUES(?,?,?,?,?,?,?,?)").run(q,22,block("template","q"+q),9,n,JSON.stringify(Array.from({length:n},(_,i)=>1001+i)),0,"2026-10-01 00:00:00");
  db.prepare("INSERT INTO exam_answer_keys VALUES(?,?,?)").run(22,q,"ref-"+q);
 }
 for(let i=1;i<=n;i++)addPaper(i);
 return {def,raw};
}
function select(sql,...params){return JSON.parse(JSON.stringify(db.prepare(sql).all(...params)));}
async function error(fn,status){await assert.rejects(fn,e=>e.status===status);count++;}
async function check(name,fn){await fn();count++;console.log("PASS",name);}
async function suggestions(){
 const template=db.prepare("SELECT definition_json FROM legacy_pdf_templates").get().definition_json;
 for(const m of select("SELECT m.*,s.serial_no FROM legacy_pdf_marks m JOIN legacy_paper_serials s ON s.paper_id=m.paper_id WHERE m.paper_id='paper-1'")){
  const n=Number(m.question_id.slice(1)),pages=select("SELECT * FROM legacy_pdf_pages WHERE paper_id=? ORDER BY id",m.paper_id);
  const input={templateId:"template",definitionHash:sha(template),pages:pages.map(p=>({id:p.id,role:p.page_role,version:p.version,path:p.aligned_path,hash:sha(fs.readFileSync(p.aligned_path))}))};
  db.prepare("INSERT INTO legacy_ai_score_suggestions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("ai-"+n,22,m.paper_id,1,m.crop_id,n,"completed",n<=55?0.5:1,n<=55?1:2,"ref-"+n,"reason-"+n,"v1",sha("ref-"+n),JSON.stringify(input),"2026-10-01");
 }
}
async function main(){
 fixture=await fsp.mkdtemp(path.join(os.tmpdir(),"legacy-group-tests-"));process.env.ANSWER_CARD_DATA_DIR=fixture;
 for(const role of ["front","back"])await sharp({create:{width:1000,height:1200,channels:3,background:"#ffffff"}}).png().toFile(path.join(fixture,role+".png"));
 scoreService=load("src/server/services/LegacyReviewGroupScoreService.ts",{});
 aiService=load("src/server/services/AiScoreSuggestionService.ts",{"../db":{getMysqlDb:()=>adapter},"./ReviewPoolService":{}});
 service=load("src/server/services/LegacyReviewGroupService.ts",{
  sharp,"../db":{getMysqlDb:()=>adapter},"../db/timestamp":{databaseTimestamp:()=>"2026-10-14 00:00:00"},
  "../../apps/answer-card/server/middleware":{canGradeBlock:async()=>authAllowed},
  "../../shared/legacyPdf":{normalizePdfTemplate:x=>x},
  "../../shared/reviewPoolLimits":{CLAIM_LOCK_TIMEOUT_MS:3000,MAX_HELD_PAPERS_PER_BLOCK:20,MAX_HELD_PAPERS_TOTAL:60},
  "./LegacyPdfService":{legacyBlockId:block,recomputeLegacyPaperTotals:async()=>{
    if(failTotals)throw Error("injected total failure");const r=db.prepare("SELECT SUM(score) n FROM legacy_review_group_scores WHERE paper_id='paper-1'").get();return 80+Number(r.n);
  }},
  "./LegacyReviewGroupScoreService":scoreService,"./AiScoreSuggestionService":aiService,
  "./examPublishEvents":{markScoreMutated:async()=>{}}
 });
 await check("SQL aggregate list: no marks decoration or filesystem stats",async()=>{
  seed(707);log=[];
  const t=performance.now(),groups=await service.listLegacyReviewGroups(req(),adapter),elapsed=performance.now()-t;
  assert.equal(groups.length,2);assert.equal(groups[0].assignedCount,707);assert.equal(groups[1].pendingCount,707);
  assert.equal(log.filter(x=>x.sql.startsWith("SELECT * FROM review_assignments")).length,1);
  assert.equal(log.filter(x=>x.sql.includes("SELECT m.*")).length,0);assert.equal(log.filter(x=>x.sql.includes("SELECT id,paper_id,page_role")).length,0);
  console.log("707-paper in-memory aggregate elapsed ms",elapsed.toFixed(2));
 });
 await check("GroupItem contract, SQL pool slicing, stable signatures",async()=>{
  seed();const a=await service.getLegacyReviewGroupPool(req(),adapter),b=await service.getLegacyReviewGroupPaper(req(),adapter);
  assert.equal(a.items.length,3);assert.equal(a.stats.assignedCount,3);assert.equal(a.items[0].inputSignature,b.inputSignature);
  assert.deepEqual(Object.keys(b).sort(),["serialNumber","paperId","score","version","inputSignature","status","claimedBy","imageUrl","oldScores","maxScore","title"].sort());
  assert.equal(b.score,null);assert.equal(b.oldScores.length,10);assert.equal(b.oldScores[0].reviewerName,"Reviewer");
  assert.ok(!JSON.stringify(b).includes("student"));assert.equal(await service.getLegacyReviewGroupPaper(req({params:{serial:"900"}}),adapter),null);
 });
 await check("allocation canonical order and allocation changes invalidate signatures",async()=>{
  seed();const before=await service.getLegacyReviewGroupPaper(req(),adapter);
  db.prepare("UPDATE review_assignments SET assigned_student_ids=?").run("[1003,1002,1001]");
  assert.equal((await service.getLegacyReviewGroupPaper(req(),adapter)).inputSignature,before.inputSignature);
  const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  db.prepare("UPDATE review_assignments SET assigned_student_ids=?,student_count=4 WHERE teacher_id=9").run("[1001,1002,1003,1004]");
  await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{score:5,version:claimed.version,inputSignature:claimed.inputSignature,requestId:"stale-allocation"}}),adapter),409);
  assert.equal(select("SELECT * FROM legacy_pdf_audit").length,0);
  assert.equal(select("SELECT score FROM legacy_review_group_scores")[0].score,null);
  db.prepare("UPDATE review_assignments SET assigned_student_ids='[1001]' WHERE id=46").run();
  await error(()=>service.getLegacyReviewGroupPaper(req(),adapter),409);
 });
 await check("draft/transition/readonly freeze claim, submit, adoption",async()=>{
  seed();const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  for(const mode of ["draft","transition","readonly"]){
   db.prepare("UPDATE legacy_review_groups SET mode=? WHERE group_id='english-46-55'").run(mode);
   await error(()=>service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter),409);
   await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{score:0,version:claimed.version,inputSignature:claimed.inputSignature,requestId:mode}}),adapter),409);
   await error(()=>service.adoptLegacyReviewGroupAi(req({method:"POST",body:{suggestionIds:[]}}),adapter),409);
  }
 });
 await check("zero, half steps, persistent replay, request conflict, old data unchanged",async()=>{
  seed();const old=select("SELECT * FROM legacy_pdf_marks"),assign=select("SELECT * FROM review_assignments");
  const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  const body={score:0,version:claimed.version,inputSignature:claimed.inputSignature,requestId:"zero"};
  const saved=await service.submitLegacyReviewGroup(req({method:"POST",body}),adapter);
  assert.equal(saved.data.score,0);assert.equal(saved.data.version,1);assert.equal(saved.data.claimedBy,null);assert.equal(saved.paperTotalScore,80);
  assert.equal((await service.submitLegacyReviewGroup(req({method:"POST",body}),adapter)).reused,true);
  await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{...body,score:1}}),adapter),409);
  assert.equal(select("SELECT * FROM legacy_pdf_audit").length,1);assert.deepEqual(select("SELECT * FROM legacy_pdf_marks"),old);
  assert.deepEqual(select("SELECT * FROM review_assignments"),assign);
  const again=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  const half=await service.submitLegacyReviewGroup(req({method:"POST",body:{score:7.5,version:again.version,inputSignature:again.inputSignature,requestId:"half"}}),adapter);
  assert.equal(half.data.score,7.5);assert.equal(half.paperTotalScore,87.5);
  for(const score of [null,"",false,"0",0.25,-1,11,NaN])assert.throws(()=>service.validateGroupScore(score),e=>e.status===422);
 });
 await check("transaction rollback includes audit, score, lease, dedup",async()=>{
  seed();const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);failTotals=true;
  await assert.rejects(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{score:3,version:0,inputSignature:claimed.inputSignature,requestId:"rollback"}}),adapter),/injected/);
  const row=select("SELECT * FROM legacy_review_group_scores")[0];
  assert.equal(row.score,null);assert.equal(row.version,0);assert.equal(row.claimed_by,9);
  assert.equal(select("SELECT * FROM legacy_pdf_audit").length,0);assert.equal(select("SELECT * FROM legacy_review_group_requests").length,0);
 });
 await check("scope mismatch, holding quota, child lease, version conflict",async()=>{
  seed();db.prepare("UPDATE review_assignments SET teacher_id=10").run();authAllowed=false;
  await error(()=>service.getLegacyReviewGroupPaper(req(),adapter),403);
  seed();db.prepare("UPDATE answer_block_crops SET claimed_by=10 WHERE id='paper-1-q46'").run();
  await error(()=>service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter),409);
  seed();for(let i=100;i<160;i++)db.prepare("INSERT INTO legacy_review_group_scores VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(22,i,"other","quota-"+i,null,10,"ready",0,null,null,"teacher",9,"now",null);
  await error(()=>service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter),403);
  seed();const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{score:2,version:1,inputSignature:claimed.inputSignature,requestId:"wrong-version"}}),adapter),409);
 });
 await check("bounded preview, wraparound, own claim reuse, no child redistribution",async()=>{
  seed(707);log=[];
  const p=await service.previewLegacyReviewGroup(req({query:{afterSerial:"706"}}),adapter);assert.equal(p.serialNumber,707);
  assert.ok(log.some(x=>x.sql.includes("LIMIT 2 OFFSET ?")));
  const paperQuery=log.find(x=>x.sql.startsWith("SELECT p.id paper_id"));assert.ok(paperQuery.params.length<=2+32+707);
  const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),false,adapter);
  assert.equal((await service.claimLegacyReviewGroup(req({method:"POST"}),false,adapter)).serialNumber,claimed.serialNumber);
  assert.equal(select("SELECT * FROM legacy_review_group_scores WHERE claimed_by=9").length,1);
 });
 await check("existing AI validator covers all members; audited draft adoption",async()=>{
  seed();await suggestions();const aggregate=await service.getLegacyReviewGroupAi(req(),adapter);
  assert.equal(aggregate.score,5);assert.equal(aggregate.suggestionIds.length,10);assert.equal(aggregate.reasons[0].questionNumber,46);
  const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  const adopted=await service.adoptLegacyReviewGroupAi(req({method:"POST",body:{suggestionIds:aggregate.suggestionIds}}),adapter);
  assert.equal(adopted.formalScoreWritten,false);assert.equal(select("SELECT score FROM legacy_review_group_scores")[0].score,null);
  assert.equal(select("SELECT * FROM legacy_ai_score_adoptions").length,10);
  db.prepare("UPDATE legacy_ai_score_suggestions SET status='failed' WHERE question_number=55").run();
  assert.equal(await service.getLegacyReviewGroupAi(req(),adapter),null);
  await error(()=>service.adoptLegacyReviewGroupAi(req({method:"POST",body:{suggestionIds:aggregate.suggestionIds}}),adapter),409);
  db.prepare("UPDATE legacy_ai_score_suggestions SET status='completed' WHERE question_number=55").run();
  db.prepare("UPDATE exam_answer_keys SET answer_text='changed' WHERE question_number=46").run();
  assert.equal(await service.getLegacyReviewGroupAi(req(),adapter),null);
 });
 await check("union image, version URL conflict, identity-overlap rejection, 32MiB bound",async()=>{
  const {def}=seed();const item=await service.getLegacyReviewGroupPaper(req(),adapter);
  const file=await service.getLegacyReviewGroupImage(req({query:{signature:item.inputSignature}}),adapter),meta=await sharp(file).metadata();
  assert.ok(meta.width>0&&meta.height>0);assert.equal(meta.format,"webp");assert.ok(fs.statSync(file).size<=32*1024*1024);
  assert.equal(await service.getLegacyReviewGroupImage(req({query:{signature:item.inputSignature}}),adapter),file);
  await error(()=>service.getLegacyReviewGroupImage(req({query:{signature:"bad"}}),adapter),409);
  const bad=structuredClone(def);bad.identities[0].rect.y=0.25;
  assert.throws(()=>service.unionGroupRegions({id:"english-46-55"},bad,bad.questions.slice(0,10)),e=>e.status===409);
 });
 await check("three-image lookahead follows assignment order without claims or score writes",async()=>{
  seed(10);
  const before=JSON.stringify(select("SELECT * FROM legacy_pdf_marks"));
  const previews=await service.previewLegacyReviewGroups(req({query:{afterSerial:"4"}}),adapter);
  assert.equal(previews.map(p=>p.serialNumber).join(','),'5,6,7');
  assert.equal(select("SELECT * FROM legacy_review_group_scores").length,0);
  assert.equal(JSON.stringify(select("SELECT * FROM legacy_pdf_marks")),before);
 });
 await check("next pending skips the current paper and releases its unfinished claim",async()=>{
  seed();
  const first=await service.claimLegacyReviewGroup(req({method:"POST"}),false,adapter);
  assert.equal(first.serialNumber,1);
  const preview=await service.previewLegacyReviewGroup(req({query:{afterSerial:"1"}}),adapter);
  assert.equal(preview.serialNumber,2);
  const second=await service.claimLegacyReviewGroup(req({method:"POST",body:{afterSerial:1}}),false,adapter);
  assert.equal(second.serialNumber,2);
  assert.equal(select("SELECT claimed_by FROM legacy_review_group_scores WHERE serial_no=1 AND group_id='english-46-55'")[0].claimed_by,null);
  assert.equal(select("SELECT claimed_by FROM legacy_review_group_scores WHERE serial_no=2 AND group_id='english-46-55'")[0].claimed_by,9);
  const third=await service.claimLegacyReviewGroup(req({method:"POST",body:{afterSerial:2}}),false,adapter);
  assert.equal(third.serialNumber,3);
  assert.equal(select("SELECT claimed_by FROM legacy_review_group_scores WHERE serial_no=2 AND group_id='english-46-55'")[0].claimed_by,null);
 });
 await check("only assigned reviewed rows are decorated",async()=>{
  seed();assert.equal((await service.getLegacyReviewGroupReviewed(req(),adapter)).length,0);
  const claimed=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  await service.submitLegacyReviewGroup(req({method:"POST",body:{score:1,version:0,inputSignature:claimed.inputSignature,requestId:"reviewed"}}),adapter);
  const rows=await service.getLegacyReviewGroupReviewed(req(),adapter);assert.equal(rows.length,1);assert.equal(rows[0].serialNumber,1);
 });
 await check("parallel duplicate submits serialize and commit one audit",async()=>{
  seed();const p=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  const body={score:4,version:p.version,inputSignature:p.inputSignature,requestId:"parallel"};
  const results=await Promise.all([service.submitLegacyReviewGroup(req({method:"POST",body}),adapter),service.submitLegacyReviewGroup(req({method:"POST",body}),adapter)]);
  assert.equal(results.filter(r=>r.reused).length,1);assert.equal(select("SELECT * FROM legacy_pdf_audit").length,1);
  db.prepare("UPDATE legacy_review_groups SET mode='transition'").run();
  await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body}),adapter),409);
 });
 await check("source changes reject stale input; owned claim can refresh signature",async()=>{
  seed();const p=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  db.prepare("UPDATE legacy_pdf_pages SET version=2 WHERE paper_id='paper-1'").run();
  await error(()=>service.submitLegacyReviewGroup(req({method:"POST",body:{score:3,version:0,inputSignature:p.inputSignature,requestId:"changed-page"}}),adapter),409);
  const fresh=await service.claimLegacyReviewGroup(req({method:"POST"}),true,adapter);
  assert.notEqual(fresh.inputSignature,p.inputSignature);
  const saved=await service.submitLegacyReviewGroup(req({method:"POST",body:{score:3,version:0,inputSignature:fresh.inputSignature,requestId:"fresh-page"}}),adapter);
  assert.equal(saved.data.score,3);
 });
 await check("HTTP response contracts and protected identity fields",async()=>{
  seed();const express=require(path.join(dep,"express")),app=express();
  const middleware=(req,res,next)=>{req.user={id:9,role_id:2,role_name:"teacher",teacher_role:null};next();};
  const routes=load("src/server/routes/legacy-review-groups.ts",{
   express,"../middleware/auth":{requirePermission:()=>middleware},
   "../auth/permissions":{PERMISSIONS:{GRADE_READ:"read",GRADE_WRITE:"write"}},
   "../../apps/answer-card/server/middleware":{requireExamAccess:middleware},
   "../services/LegacyReviewGroupService":service
  });
  app.use(express.json());app.use("/api/review-groups",routes.default);
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const origin="http://127.0.0.1:"+server.address().port,base="/api/review-groups/exams/22/groups/english-46-55";
  const get=async url=>{const response=await fetch(origin+url);assert.equal(response.status,200);return response.json();};
  const post=async(url,body)=>{const response=await fetch(origin+url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});assert.equal(response.status,200);return response.json();};
  try{
   const list=await get("/api/review-groups/exams/22");
   assert.deepEqual(Object.keys(list).sort(),["groups","ok"]);
   assert.deepEqual(Object.keys(list.groups[0]).sort(),["id","title","questionNumbers","maxScore","mode","assignedCount","pendingCount","reviewedCount","heldCount"].sort());
   const pool=await get(base);assert.deepEqual(Object.keys(pool.data).sort(),["items","stats"]);
   const preview=await get(base+"/next-preview");assert.equal(preview.data.serialNumber,1);
   const claimed=await post(base+"/claim-next");assert.equal(claimed.data.claimedBy,9);
   const specific=await post(base+"/papers/1/claim");assert.equal(specific.data.serialNumber,1);
   const paper=await get(base+"/papers/1");assert.equal(paper.data.oldScores.length,10);
   const reference=await get(base+"/reference");assert.equal(reference.data.questions.length,10);assert.equal(reference.data.questions[0].answerText,"ref-46");
   assert.equal((await get(base+"/papers/1/ai")).data,null);
   await suggestions();
   const ai=await get(base+"/papers/1/ai");assert.equal(ai.data.score,5);assert.equal(ai.data.reasons.length,10);
   const adoption=await post(base+"/papers/1/adopt-ai",{suggestionIds:ai.data.suggestionIds});
   assert.deepEqual(Object.keys(adoption).sort(),["ok","data","formalScoreWritten"].sort());assert.equal(adoption.formalScoreWritten,false);
   const submitted=await post(base+"/papers/1/submit",{score:0,version:paper.data.version,inputSignature:paper.data.inputSignature,requestId:"http-submit"});
   assert.deepEqual(Object.keys(submitted).sort(),["ok","data","paperTotalScore","reused"].sort());assert.equal(submitted.data.score,0);
   const reviewed=await get(base+"/reviewed");assert.equal(reviewed.data.length,1);
   const response=await fetch(origin+submitted.data.imageUrl);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/webp");
   assert.ok(!JSON.stringify([list,pool,claimed,paper,submitted]).includes("student_id"));
  }finally{await new Promise(resolve=>server.close(resolve));}
 });

 await check("admin progress replaces historical children and agrees with teacher counts including zero",async()=>{
  seed();db.prepare("INSERT INTO users VALUES(?,?)").run(9,"Teacher");
  db.prepare("UPDATE legacy_pdf_marks SET score=NULL,status='ready'").run();
  for(const group of ["english-46-55","english-56-60"]){
   db.prepare("INSERT INTO legacy_review_group_scores(exam_id,serial_no,group_id,paper_id,score,max_score,status,graded_by,claimed_by) VALUES(22,1,?,'paper-1',0,10,'reviewed',9,NULL)").run(group);
   db.prepare("INSERT INTO legacy_review_group_scores(exam_id,serial_no,group_id,paper_id,score,max_score,status,graded_by,claimed_by) VALUES(22,2,?,'paper-2',NULL,10,'ready',NULL,9)").run(group);
  }
  const before=JSON.stringify(select("SELECT * FROM legacy_pdf_marks"));log=[];
  const result=await service.readLegacyReviewGroupTeacherProgress(22,adapter);
  assert.equal(result.rows.length,2);assert.equal(result.replacedBlockIds.size,15);
  const mine=await service.listLegacyReviewGroups(req(),adapter);
  for(const row of result.rows){const teacher=mine.find(g=>g.id===row.blockId);
   assert.equal(row.assignedCount,teacher.assignedCount);assert.equal(row.scoredCount,teacher.reviewedCount);
   assert.equal(row.claimedCount,teacher.heldCount);assert.equal(row.scoredCount,1);assert.equal(row.claimedCount,1);
  }
  assert.equal(JSON.stringify(select("SELECT * FROM legacy_pdf_marks")),before);
  assert(log.every(q=>q.sql.trim().startsWith("SELECT")));
 });
 await check("admin group counts respect student allocation and draft mode; unrelated exams use old progress",async()=>{
  seed();db.prepare("INSERT INTO users VALUES(?,?)").run(9,"Teacher");
  db.prepare("UPDATE review_assignments SET assigned_student_ids='[1001]',student_count=1").run();
  db.prepare("UPDATE legacy_review_groups SET mode='draft' WHERE group_id='english-46-55'").run();
  const result=await service.readLegacyReviewGroupTeacherProgress(22,adapter);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].assignedCount,1);assert.equal(result.replacedBlockIds.size,5);
  assert.equal((await service.readLegacyReviewGroupTeacherProgress(21,adapter)).rows.length,0);
  db.prepare("UPDATE review_assignments SET assigned_student_ids='[1002]' WHERE id=56").run();
  await error(()=>service.readLegacyReviewGroupTeacherProgress(22,adapter),409);
 });

 console.log("PASS assertions/cases",count);
}
main().then(async()=>{db?.close();await fsp.rm(fixture,{recursive:true,force:true});}).catch(async e=>{
 console.error(e);db?.close();if(fixture)await fsp.rm(fixture,{recursive:true,force:true});process.exitCode=1;
});
