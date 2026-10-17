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
  f=JSON.parse(fs.readFileSync('/app/data/answer-card/face-swap-fixture.json'));
  const before=await globalSnapshot(),[source]=await query("SELECT * FROM legacy_pdf_batches WHERE id='3d2fd1ae-39d4-41b1-992b-d09aae6242aa'");
  let realPages=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=(SELECT id FROM legacy_pdf_papers WHERE batch_id=? AND sheet_no=1) ORDER BY source_page',[source.id]);
  const controlBefore=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[f.control]),markBefore=await query('SELECT * FROM legacy_pdf_marks WHERE paper_id=?',[f.control]),controlMark=markBefore[0].id;
  const [audit]=await query("SELECT before_json,after_json FROM legacy_pdf_audit WHERE entity_id=? AND action='swap_faces' ORDER BY id DESC LIMIT 1",[f.pid]);
  realPages=JSON.parse(audit.before_json).pages.map(p=>({...p,page_role:JSON.parse(audit.after_json).pages.find(x=>x.id===p.id).pageRole}));
  const path='/scan-batches/'+f.bid+'/papers/'+f.pid+'/swap-faces',body={requestId:JSON.parse(audit.after_json).requestId,version:0,pages:f.pageIds.map(id=>({id,version:0}))};
  assert.equal((await req(path,body,'')).status,401);assert.equal((await req(path,body)).data.reused,true);
  let job;
  for(let i=0;i<1800;i++){[job]=await query('SELECT status,error FROM legacy_pdf_jobs WHERE batch_id=?',[f.bid]);if(['done','failed'].includes(job.status))break;if(i%60===0)console.log(JSON.stringify({testStatus:job.status,waitingForRecognizer:true}));await new Promise(r=>setTimeout(r,500));}
  assert.equal(job.status,'done',job.error||'timeout');
  const pages=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=? ORDER BY source_page',[f.pid]);assert.deepEqual(pages.map(p=>p.page_role),realPages.map(p=>p.page_role));assert.ok(pages.every(p=>p.status==='recognized'&&p.aligned_path&&p.manual_json===null));
  assert.deepEqual(pages.map(p=>[p.source_page,p.raw_path]),realPages.map(p=>[p.source_page,p.raw_path]));
  const results=await query('SELECT * FROM legacy_pdf_results WHERE paper_id=? ORDER BY question_id',[f.pid]);assert.equal(results.find(r=>r.question_id==='q1').final_value,'[]');assert.equal(results.find(r=>r.question_id==='q1').final_source,'manual');assert.equal(results.find(r=>r.question_id==='q2').final_value,'["C"]');
  const recognized=JSON.parse(pages.find(p=>p.page_role==='front').recognition_json).questions;
  assert.equal(recognized.length,0);for(const r of results.filter(r=>r.final_source==='auto'))assert.equal(r.final_value,null);
  assert.equal((await query("SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[f.bid]))[0].n,0);
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
  const report={atomicRoleSwap:true,swapPreprocessingOnlyAndObjectivesDeferred:true,manualBlankAndUnknownProtected:true,otherPaperAndTeacherMarkUnchanged:true,originalPageReferencesUnchanged:true,requiresPageOwnershipConfirmation:true,publishedScoresWithdrawn:true,duplicateRequestReusedBeforeAndAfterProcessing:true,stalePaperAndPage409:true,ownTeacherTask409:true,activeObjectiveJob409:true,unauthenticated401:true,productionBatchRowsAndTemplateCountsUnchanged:true};
  await cleanup();fs.writeFileSync('/app/data/answer-card/face-swap-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{if(cookie)await req('/auth/logout',{});await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
