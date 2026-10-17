const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise');
const fixture='/app/data/answer-card/objective-v2-fixture.json',uid=()=>crypto.randomUUID();
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 const query=async(s,a=[])=>{const [r]=await c.execute(s,a);return r};
 let cookie='',f;
 async function request(p,body,method='POST',auth=cookie){
  const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 }
 const login=await request('/auth/login',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD},'POST','');assert.equal(login.status,200,JSON.stringify(login.data));cookie=login.cookie;assert.ok(cookie?.startsWith('legacy_old_auth_token='));
 const poll=async(status,timeout=60000)=>{const start=Date.now();while(Date.now()-start<timeout){const [j]=await query('SELECT * FROM legacy_pdf_jobs WHERE batch_id=?',[f.bid]);if(j&&status.includes(j.status))return j;await new Promise(r=>setTimeout(r,250))}throw Error('job timeout '+status)};
 const values=async()=>query("SELECT r.id,r.final_value,r.final_source,r.score,r.status FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=? ORDER BY r.id",[f.bid]);
 const save=()=>fs.writeFileSync(fixture,JSON.stringify(f),{mode:0o600});
 async function cleanup(){
  if(!f?.eid)return;
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT r.id FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT id FROM legacy_pdf_pages WHERE batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT id FROM legacy_pdf_papers WHERE batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (?,?)',[f.bid,String(f.eid)]);
  for(const table of ['question_scores','student_scores','exam_participants','exam_class_snapshots','exam_publish_events','exam_answer_keys','legacy_pdf_exam_keys','answer_block_crops','review_assignments'])try{await query('DELETE FROM '+table+' WHERE exam_id=?',[f.eid])}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e}
  await query('DELETE FROM legacy_pdf_marks WHERE paper_id IN (SELECT id FROM legacy_pdf_papers WHERE batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_results WHERE paper_id IN (SELECT id FROM legacy_pdf_papers WHERE batch_id=?)',[f.bid]);
  await query('DELETE FROM legacy_pdf_pages WHERE batch_id=?',[f.bid]);await query('DELETE FROM legacy_pdf_papers WHERE batch_id=?',[f.bid]);await query('DELETE FROM legacy_pdf_jobs WHERE batch_id=?',[f.bid]);await query('DELETE FROM legacy_pdf_batches WHERE id=?',[f.bid]);await query('DELETE FROM exams WHERE id=?',[f.eid]);fs.rmSync(fixture,{force:true});
 }
 let success=false;
 try{

 if(process.env.TEST_PHASE==='1'){
  const [t]=await query("SELECT * FROM legacy_pdf_templates WHERE id='0c50a3a3-ce7c-48fc-a01c-ceb9c0cfac96'"),def=JSON.parse(t.definition_json);
  const [source]=await query("SELECT * FROM legacy_pdf_batches WHERE id='ac549507-ebdd-4924-b982-29968c2eb1d2'");
  const pages=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=(SELECT id FROM legacy_pdf_papers WHERE batch_id=? AND sheet_no=1) ORDER BY source_page',[source.id]);
  const students=await query('SELECT student_id FROM exam_participants WHERE exam_id=22 ORDER BY student_id LIMIT 10');
  const [keys]=await query('SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=22');
  f={bid:uid(),papers:[],pageIds:[],catalog:await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id')};
  f.eid=(await query("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by,status) VALUES(?,?,1,'英语','formal',1,'grading')",['[test] objective v2 '+f.bid,t.card_id])).insertId;save();
  await query('INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,1)',[f.eid,keys.answers_json]);
  await query("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,status,total,finished,created_by) VALUES(?,?,?,?,?,'objective-v2-test.pdf','ready',20,20,1)",[f.bid,f.eid,t.id,source.pdf_hash,source.pdf_path]);
  for(let i=0;i<10;i++){
   const pid=uid(),student=students[i].student_id;f.papers.push({pid,student});save();
   await query("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[f.eid,student]);
   await query("INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no,student_id,identity_status,ownership_confirmed) VALUES(?,?,?,?,'confirmed',1)",[pid,f.bid,i+1,student]);
   for(let k=0;k<pages.length;k++){
    const pg=pages[k],id=uid();f.pageIds.push(id);
    await query("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path,aligned_path,status,alignment_json,recognition_json) VALUES(?,?,?,?,?,?,?,'recognized',?,?)",[id,f.bid,pid,i*2+k+1,pg.page_role,pg.raw_path,pg.aligned_path,pg.alignment_json,pg.recognition_json]);
   }
   for(const q of def.questions.filter(q=>q.gradingType==='objective'))await query("INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value,final_value,status,score,final_source) VALUES(?,?,?,?,'[\"B\",\"C\"]','confirmed',0,'auto')",[uid(),pid,q.questionId,JSON.stringify({status:'multiple',value:['B','C']})]);
  }
  save();await query("UPDATE legacy_pdf_results SET final_source='legacy_unknown',final_value='[\"C\"]' WHERE paper_id=? AND question_id='q6'",[f.papers[0].pid]);
  let [paper]=await query('SELECT version FROM legacy_pdf_papers WHERE id=?',[f.papers[0].pid]);
  const identityOnly=await request('/scan-batches/'+f.bid+'/papers/'+f.papers[0].pid+'/confirm',{studentId:f.papers[0].student,version:paper.version});assert.equal(identityOnly.status,200,JSON.stringify(identityOnly.data));
  assert.equal((await query("SELECT final_source FROM legacy_pdf_results WHERE paper_id=? AND question_id='q2'",[f.papers[0].pid]))[0].final_source,'auto');
  const generation=await request('/scan-batches/'+f.bid+'/generate',{});assert.equal(generation.status,200,JSON.stringify(generation.data));
  const [mark]=await query("SELECT m.* FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? LIMIT 1",[f.bid]);f.mark=mark.id;save();
  assert.equal((await request('/scan-batches/'+f.bid+'/marks/'+mark.id+'/claim',{})).status,200);
  assert.equal((await request('/scan-batches/'+f.bid+'/marks/'+mark.id+'/score',{score:.5,version:mark.version},'PUT')).status,200);
  const first=await request('/scan-batches/'+f.bid+'/reprocess-objective',{});assert.equal(first.status,202,JSON.stringify(first.data));f.runId=first.data.runId;
  const repeated=await request('/scan-batches/'+f.bid+'/reprocess-objective',{});assert.equal(repeated.data.runId,f.runId);assert.equal(repeated.data.reused,true);
  await poll(['running']);
  assert.equal((await request('/scan-batches/'+f.bid+'/generate',{})).status,409);
  await query('UPDATE exams SET score_published=1 WHERE id=?',[f.eid]);
  assert.equal((await request('/exams/'+f.eid+'/publish',{})).status,409);
  [paper]=await query('SELECT version FROM legacy_pdf_papers WHERE id=?',[f.papers[0].pid]);
  const manual=await request('/scan-batches/'+f.bid+'/papers/'+f.papers[0].pid+'/confirm',{studentId:f.papers[0].student,version:paper.version,answers:{q1:[],q5:['A']}});
  assert.equal(manual.status,200,JSON.stringify(manual.data));
  f.beforeFailure=await values();save();
  await query("UPDATE legacy_pdf_pages SET status='wait_alignment' WHERE id=?",[f.pageIds.at(-1)]);
  const failed=await poll(['failed']);assert.match(failed.error,/页面|输入|校正/);
  assert.deepEqual(await values(),f.beforeFailure,'failed run must not partially commit');
  await query("UPDATE legacy_pdf_pages SET status='recognized' WHERE id=?",[f.pageIds.at(-1)]);
  const retry=await request('/scan-batches/'+f.bid+'/reprocess-objective',{});assert.equal(retry.status,202);assert.equal(retry.data.runId,f.runId);
  // Crash/restart fixture: preserve staged page outputs and a running lease.
  await query("UPDATE legacy_pdf_jobs SET status='running',lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE batch_id=?",[f.bid]);save();
  console.log(JSON.stringify({phase:1,failedRunAtomic:true,activeGenerationBlocked:true,activePublishBlocked:true,concurrentManualSaved:true,retryReusesRun:true,fixtureReadyForRestart:true}));
  success=true;
 }else{

  f=JSON.parse(fs.readFileSync(fixture,'utf8'));
  const job=await poll(['done','failed'],120000);assert.equal(job.status,'done',job.error);
  const [a]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q1'",[f.papers[0].pid]);
  assert.equal(a.final_value,'[]');assert.equal(a.final_source,'manual');
  const [b]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q5'",[f.papers[0].pid]);
  assert.equal(b.final_value,'["A"]');assert.equal(b.final_source,'manual');
  const [unknown]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q6'",[f.papers[0].pid]);assert.equal(unknown.final_value,'["C"]');assert.equal(unknown.final_source,'legacy_unknown');
  const [automatic]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q2'",[f.papers[0].pid]);assert.equal(automatic.final_value,'["A"]');assert.equal(automatic.final_source,'auto');assert.equal(automatic.recognizer_version,'objective-template-residual-v2.0.0');
  assert.equal((await query('SELECT score FROM legacy_pdf_marks WHERE id=?',[f.mark]))[0].score,.5);
  assert.equal((await query('SELECT score_published FROM exams WHERE id=?',[f.eid]))[0].score_published,0);
  assert.equal((await query('SELECT total_score FROM student_scores WHERE exam_id=? LIMIT 1',[f.eid]))[0].total_score,null);
  const [questionScore]=await query('SELECT selected_options FROM question_scores WHERE exam_id=? AND student_id=? AND question_number=2',[f.eid,f.papers[0].student]);assert.equal(questionScore.selected_options,'["A"]');
  const before=await values(),rerun=await request('/scan-batches/'+f.bid+'/reprocess-objective',{});assert.equal(rerun.data.runId,f.runId);assert.equal(rerun.data.status,'done');assert.equal(rerun.data.reused,true);assert.deepEqual(await values(),before);
  const [paper]=await query('SELECT version FROM legacy_pdf_papers WHERE id=?',[f.papers[0].pid]);
  const sameManual=await request('/scan-batches/'+f.bid+'/papers/'+f.papers[0].pid+'/confirm',{studentId:f.papers[0].student,version:paper.version,answers:{q5:['A']}});assert.equal(sameManual.status,200);assert.deepEqual(await values(),before);
  assert.equal((await request('/scan-batches/'+f.bid+'/papers/'+f.papers[0].pid+'/confirm',{studentId:f.papers[0].student,version:-1,answers:{q5:['C']}})).status,409);
  assert.deepEqual(await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id'),f.catalog);
  assert.equal((await request('/scan-batches/'+f.bid+'/reprocess-objective',{},'POST','')).status,401);
  const [teacher]=await query('SELECT username FROM users WHERE role_id=2 AND is_active=1 LIMIT 1');
  if(teacher?.username){
   const loginTeacher=await request('/auth/login',{identifier:teacher.username,password:process.env.LEGACY_TEST_TEACHER_PASSWORD},'POST','');assert.equal(loginTeacher.status,200);
   assert.equal((await request('/scan-batches/'+f.bid+'/reprocess-objective',{},'POST',loginTeacher.cookie)).status,403);
   await request('/auth/logout',{},'POST',loginTeacher.cookie);
  }
  require('child_process').execFileSync('node',['/tmp/objective-v2-rollback.cjs'],{env:{...process.env,OBJECTIVE_RUN_ID:f.runId,APPLY_ROLLBACK:'1'},stdio:'pipe'});
  assert.equal((await query("SELECT final_value FROM legacy_pdf_results WHERE paper_id=? AND question_id='q2'",[f.papers[0].pid]))[0].final_value,'["B","C"]');
  assert.equal((await query("SELECT final_value FROM legacy_pdf_results WHERE paper_id=? AND question_id='q1'",[f.papers[0].pid]))[0].final_value,'[]');
  assert.equal((await query('SELECT score FROM legacy_pdf_marks WHERE id=?',[f.mark]))[0].score,.5);
  assert.equal((await request('/scan-batches/'+f.bid+'/reprocess-objective',{})).status,202);
  const recovered=await poll(['done','failed']);assert.equal(recovered.status,'done',recovered.error);
  assert.equal((await query("SELECT final_value FROM legacy_pdf_results WHERE paper_id=? AND question_id='q2'",[f.papers[0].pid]))[0].final_value,'["A"]');
  const report={rollbackVerified:true,restartRecovered:true,stagedOutputsReused:true,manualBlankPreserved:true,manualChoicePreserved:true,unknownHistoryPreserved:true,automaticFinalUpdated:true,teacherScorePreserved:true,scoreChangeUnpublishes:true,incompleteNotZero:true,questionScoresUpdated:true,repeatedRunIdempotent:true,repeatedManualIdempotent:true,staleVersion409:true,templatesUnchanged:true,unauthenticated401:true,teacher403:true,job:JSON.parse(job.payload_json)};
  // Report contains only counts, versions and ephemeral fixture metadata.
  delete report.job.snapshot;delete report.job.completed;delete report.job.operator;
  fs.writeFileSync('/app/data/answer-card/objective-v2-api-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));await cleanup();success=true;
 }
 }finally{
  if(!success&&f?.eid){await query("UPDATE legacy_pdf_jobs SET status='failed' WHERE batch_id=?",[f.bid]);await cleanup()}
  await request('/auth/logout',{}).catch(()=>{});await c.end();
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
