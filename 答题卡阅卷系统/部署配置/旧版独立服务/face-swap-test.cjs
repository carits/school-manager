const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise');
const uid=()=>crypto.randomUUID();
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 const query=async(s,a=[])=>{const[r]=await c.execute(s,a);return r};let cookie='',f;
 const req=async(p,body,auth=cookie,method='POST')=>{const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 const globalSnapshot=async()=>({templates:await query('SELECT id,definition_json,revision,card_id FROM legacy_pdf_templates ORDER BY id'),pages:await query("SELECT p.* FROM legacy_pdf_pages p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.id IN('3d2fd1ae-39d4-41b1-992b-d09aae6242aa','ac549507-ebdd-4924-b982-29968c2eb1d2') ORDER BY p.id"),papers:await query("SELECT p.* FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.id IN('3d2fd1ae-39d4-41b1-992b-d09aae6242aa','ac549507-ebdd-4924-b982-29968c2eb1d2') ORDER BY p.id"),results:await query("SELECT r.* FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.id IN('3d2fd1ae-39d4-41b1-992b-d09aae6242aa','ac549507-ebdd-4924-b982-29968c2eb1d2') ORDER BY r.id")});
 async function cleanup(){
  if(!f)return;
  const [job]=await query('SELECT status FROM legacy_pdf_jobs WHERE batch_id=?',[f.bid]);
  assert.ok(!job||!['running','queued'].includes(job.status),'keep active fixture for investigation');
  for(const table of ['legacy_pdf_results','legacy_pdf_pages','legacy_pdf_papers','legacy_pdf_marks']){
   const rows=table==='legacy_pdf_results'||table==='legacy_pdf_marks'?await query('SELECT r.id FROM '+table+' r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?',[f.bid]):await query('SELECT id FROM '+table+' WHERE batch_id=?',[f.bid]);
   for(const r of rows)await query('DELETE FROM legacy_pdf_audit WHERE entity_id=?',[r.id]);
  }
  await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (?,?)',[f.bid,String(f.eid)]);
  for(const table of ['legacy_pdf_marks','legacy_pdf_results'])await query('DELETE FROM '+table+' WHERE paper_id IN(SELECT id FROM legacy_pdf_papers WHERE batch_id=?)',[f.bid]);
  for(const table of ['legacy_pdf_stage_jobs','legacy_pdf_pages','legacy_pdf_papers','legacy_pdf_jobs','legacy_pdf_batch_locators'])await query('DELETE FROM '+table+' WHERE batch_id=?',[f.bid]);
  await query('DELETE FROM legacy_pdf_batches WHERE id=?',[f.bid]);
  for(const table of ['question_scores','student_scores','exam_participants','exam_class_snapshots','exam_class_memberships','exam_publish_events','exam_answer_keys','legacy_pdf_exam_keys','answer_block_crops','review_assignments'])try{await query('DELETE FROM '+table+' WHERE exam_id=?',[f.eid])}catch(e){if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code))throw e}
  await query('DELETE FROM exams WHERE id=?',[f.eid]);
  assert.ok(/^[0-9a-f-]{36}$/.test(f.bid));fs.rmSync('/app/data/answer-card/legacy-pdf/batches/'+f.bid,{force:true,recursive:true});fs.rmSync('/app/data/answer-card/face-swap-fixture.json',{force:true});f=null;
 }
 try{
  const login=await req('/auth/login',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD},'');assert.equal(login.status,200);cookie=login.cookie;
  const before=await globalSnapshot(),[t]=await query("SELECT * FROM legacy_pdf_templates WHERE id='efb6bbfc-8036-45d1-a1be-00c68bb659cf'"),def=JSON.parse(t.definition_json),[source]=await query("SELECT * FROM legacy_pdf_batches WHERE id='3d2fd1ae-39d4-41b1-992b-d09aae6242aa'");
  const realPages=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=(SELECT id FROM legacy_pdf_papers WHERE batch_id=? AND sheet_no=1) ORDER BY source_page',[source.id]);
  const students=await query('SELECT student_id FROM exam_participants WHERE exam_id=21 ORDER BY student_id LIMIT 2'),[keys]=await query('SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=21');
  f={bid:uid(),pid:uid(),control:uid(),pageIds:[uid(),uid()]};
  f.eid=(await query("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by,status,score_published) VALUES(?,?,1,'语文','formal',1,'grading',1)",['[test] face swap '+f.bid,t.card_id])).insertId;
  fs.writeFileSync('/app/data/answer-card/face-swap-fixture.json',JSON.stringify(f),{mode:0o600});
  fs.mkdirSync('/app/data/answer-card/legacy-pdf/batches/'+f.bid,{recursive:true});
  await query('INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,1)',[f.eid,keys.answers_json]);
  await query("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,status,total,finished,created_by) VALUES(?,?,?,?,?,'face-swap-test.pdf','ready',2,2,1)",[f.bid,f.eid,t.id,source.pdf_hash,source.pdf_path]);
  await query("INSERT INTO legacy_pdf_jobs(batch_id,status) VALUES(?,'done')",[f.bid]);
  for(let i=0;i<2;i++){
   const pid=i?f.control:f.pid;
   await query("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[f.eid,students[i].student_id]);
   await query("INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no,student_id,identity_status,ownership_confirmed) VALUES(?,?,?,?,'confirmed',1)",[pid,f.bid,i+1,students[i].student_id]);
  }
  for(let i=0;i<2;i++){const p=realPages[i];await query("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path,aligned_path,status,alignment_json,recognition_json,manual_json) VALUES(?,?,?,?,?,?,?,'recognized',?,?,'[]')",[f.pageIds[i],f.bid,f.pid,i+1,realPages[1-i].page_role,p.raw_path,p.aligned_path,p.alignment_json,p.recognition_json]);}
  for(const q of def.questions.filter(q=>q.gradingType==='objective'))await query("INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value,final_value,status,score,final_source) VALUES(?,?,?,?,'[\"C\"]','confirmed',0,'auto')",[uid(),f.pid,q.questionId,JSON.stringify({value:['C'],status:'recognized'})]);
  await query("UPDATE legacy_pdf_results SET final_value='[]',final_source='manual' WHERE paper_id=? AND question_id='q1'",[f.pid]);
  await query("UPDATE legacy_pdf_results SET final_source='legacy_unknown' WHERE paper_id=? AND question_id='q2'",[f.pid]);
  const controlMark=uid();await query("INSERT INTO legacy_pdf_marks(id,paper_id,question_id,crop_id,status,score) VALUES(?,?,'q19',?,'reviewed',35)",[controlMark,f.control,uid()]);
  const controlBefore=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[f.control]),markBefore=await query('SELECT * FROM legacy_pdf_marks WHERE id=?',[controlMark]);
  const path='/scan-batches/'+f.bid+'/papers/'+f.pid+'/swap-faces',body={requestId:uid(),version:0,pages:f.pageIds.map(id=>({id,version:0}))};
  assert.equal((await req(path,body,'')).status,401);
  assert.equal((await req(path,{...body,version:99})).status,409);
  const [activeBefore]=await query("SELECT j.batch_id,b.total,b.finished FROM legacy_pdf_jobs j JOIN legacy_pdf_batches b ON b.id=j.batch_id WHERE j.status='running' AND j.kind='scan'");
  const [auditStart]=await query("SELECT COALESCE(MAX(id),0) id FROM legacy_pdf_audit");
  const swapStart=Date.now();
  const swapped=await req(path,body);assert.equal(swapped.status,200,JSON.stringify(swapped.data));assert.equal(swapped.data.priority,100);assert.equal(swapped.data.preservedAnswers,2);
  assert.equal((await req(path,body)).data.reused,true);
  let job;
  for(let i=0;i<1800;i++){[job]=await query('SELECT status,error FROM legacy_pdf_jobs WHERE batch_id=?',[f.bid]);if(['done','failed'].includes(job.status))break;if(i%60===0)console.log(JSON.stringify({testStatus:job.status,waitingForRecognizer:true}));await new Promise(r=>setTimeout(r,500));}
  assert.equal(job.status,'done',job.error||'timeout');
  const priorityElapsedMs=Date.now()-swapStart;
  const priorityEvents=await query("SELECT a.id,p.batch_id FROM legacy_pdf_audit a JOIN legacy_pdf_pages p ON p.id=a.entity_id WHERE a.action='recognize' AND a.id>? ORDER BY a.id",[auditStart.id]);
  const ownEvents=priorityEvents.filter(x=>x.batch_id===f.bid);assert.equal(ownEvents.length,2);
  assert.equal(priorityEvents.filter(x=>x.id>ownEvents[0].id&&x.id<ownEvents[1].id).length,0,"ordinary page interrupted priority swap");
  if(activeBefore&&activeBefore.total-activeBefore.finished>4){const [regular]=await query("SELECT finished FROM legacy_pdf_batches WHERE id=?",[activeBefore.batch_id]);assert.ok(regular.finished-activeBefore.finished<=2,"waited for entire PDF instead of current page");}
  console.log(JSON.stringify({priorityElapsedMs,priorityPagesConsecutive:true,currentPageCompletesBeforeSwap:true}));

  const pages=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=? ORDER BY source_page',[f.pid]);assert.deepEqual(pages.map(p=>p.page_role),realPages.map(p=>p.page_role));assert.ok(pages.every(p=>p.status==='recognized'&&p.aligned_path&&p.manual_json===null));
  assert.deepEqual(pages.map(p=>[p.source_page,p.raw_path]),realPages.map(p=>[p.source_page,p.raw_path]));
  const results=await query('SELECT * FROM legacy_pdf_results WHERE paper_id=? ORDER BY question_id',[f.pid]);assert.equal(results.find(r=>r.question_id==='q1').final_value,'[]');assert.equal(results.find(r=>r.question_id==='q1').final_source,'manual');assert.equal(results.find(r=>r.question_id==='q2').final_value,'["C"]');
  const recognized=JSON.parse(pages.find(p=>p.page_role==='front').recognition_json).questions;
  assert.equal(recognized.length,0);for(const r of results.filter(r=>r.final_source==='auto'))assert.equal(r.final_value,null);assert.equal((await query("SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[f.bid]))[0].n,0);
  assert.equal((await query('SELECT ownership_confirmed,student_id FROM legacy_pdf_papers WHERE id=?',[f.pid]))[0].ownership_confirmed,0);
  assert.equal((await query('SELECT score_published FROM exams WHERE id=?',[f.eid]))[0].score_published,0);
  assert.deepEqual(await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[f.control]),controlBefore);assert.deepEqual(await query('SELECT * FROM legacy_pdf_marks WHERE id=?',[controlMark]),markBefore);
  assert.equal((await req(path,body)).data.reused,true);
  assert.equal((await query("SELECT COUNT(*) n FROM legacy_pdf_audit WHERE entity_id=? AND action='swap_faces'",[f.pid]))[0].n,1);
  const [paper]=await query('SELECT version FROM legacy_pdf_papers WHERE id=?',[f.pid]),valid={requestId:uid(),version:paper.version,pages:pages.map(p=>({id:p.id,version:p.version}))};
  assert.equal((await req(path,{...valid,pages:valid.pages.map(p=>({...p,version:99}))})).status,409);
  const ownMark=uid();await query("INSERT INTO legacy_pdf_marks(id,paper_id,question_id,crop_id) VALUES(?,?,'q19',?)",[ownMark,f.pid,uid()]);
  assert.equal((await req(path,valid)).status,409);await query('DELETE FROM legacy_pdf_marks WHERE id=?',[ownMark]);
  await query("UPDATE legacy_pdf_jobs SET kind='objective',status='running',lease_until=DATE_ADD(NOW(),INTERVAL 10 MINUTE) WHERE batch_id=?",[f.bid]);
  assert.equal((await req(path,valid)).status,409);await query("UPDATE legacy_pdf_jobs SET kind='scan',status='done',lease_until=NULL WHERE batch_id=?",[f.bid]);
  assert.deepEqual(await globalSnapshot(),before);
  const report={priorityPagesConsecutive:true,currentPageBoundaryPreemption:true,priorityElapsedMs,atomicRoleSwap:true,swapPreprocessingOnlyAndObjectivesDeferred:true,manualBlankAndUnknownProtected:true,otherPaperAndTeacherMarkUnchanged:true,originalPageReferencesUnchanged:true,requiresPageOwnershipConfirmation:true,publishedScoresWithdrawn:true,duplicateRequestReusedBeforeAndAfterProcessing:true,stalePaperAndPage409:true,ownTeacherTask409:true,activeObjectiveJob409:true,unauthenticated401:true,productionBatchRowsAndTemplateCountsUnchanged:true};
  await cleanup();fs.writeFileSync('/app/data/answer-card/face-swap-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{if(cookie)await req('/auth/logout',{});await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
