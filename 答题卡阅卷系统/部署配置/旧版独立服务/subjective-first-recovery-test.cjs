const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise'),bcrypt=require('/app/node_modules/bcryptjs'),{execFileSync}=require('child_process');
const uid=()=>crypto.randomUUID(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE}),q=async(s,a=[])=>{const[r]=await c.execute(s,a);return r};
 const base='http://127.0.0.1:5174/api',cookies=[];let admin='',fixture;
 const api=async(path,body,auth=admin,method='POST')=>{const r=await fetch(base+path,{method,headers:{Cookie:auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data};
 const wait=async(check,label)=>{for(let i=0;i<600;i++){const value=await check();if(value)return value;if(i%100===0)console.log(JSON.stringify({waiting:label}));await sleep(200);}throw Error('timeout '+label)};
 async function cleanup(){
  if(!fixture)return;
  await q("UPDATE legacy_pdf_batches SET objective_paused=1 WHERE id=?",[fixture.bid]);
  await q("UPDATE legacy_pdf_stage_jobs SET status='cancelled' WHERE batch_id=? AND status IN('queued','failed')",[fixture.bid]);
  await wait(async()=>!(await q("SELECT id FROM legacy_pdf_stage_jobs WHERE batch_id=? AND status='running'",[fixture.bid])).length,'fixture worker finish');await sleep(300);
  for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});
  const stageIds=await q("SELECT id FROM legacy_pdf_stage_jobs WHERE batch_id=?",[fixture.bid]);
  for(const j of stageIds){assert(/^[0-9a-f-]{36}$/.test(j.id));fs.rmSync('/app/data/answer-card/legacy-pdf/stage-runs/'+j.id,{recursive:true,force:true});}
  const markIds=await q("SELECT m.id FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=?",[fixture.bid]);
  const cache='/app/data/answer-card/legacy-pdf/cache';if(fs.existsSync(cache))for(const file of fs.readdirSync(cache))if(markIds.some(m=>file.startsWith(m.id+'_'))&&file.endsWith('.png'))fs.unlinkSync(cache+'/'+file);
  const entities=[fixture.bid,String(fixture.eid),...fixture.papers.map(p=>p.id)];
  for(const table of ['legacy_pdf_pages','legacy_pdf_results','legacy_pdf_marks']){
   const rows=table==='legacy_pdf_pages'?await q('SELECT id FROM '+table+' WHERE batch_id=?',[fixture.bid]):await q('SELECT r.id FROM '+table+' r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?',[fixture.bid]);
   entities.push(...rows.map(r=>r.id));
  }
  await q('DELETE FROM legacy_pdf_audit WHERE entity_id IN ('+entities.map(()=>'?').join(',')+')',entities);
  for(const table of ['review_assignments','review_sessions','question_scores','student_scores','answer_block_crops','exam_participants','exam_answer_keys','legacy_pdf_exam_keys','exam_publish_events'])await q('DELETE FROM '+table+' WHERE exam_id=?',[fixture.eid]);
  for(const table of ['legacy_pdf_results','legacy_pdf_marks'])await q('DELETE FROM '+table+' WHERE paper_id IN(SELECT id FROM legacy_pdf_papers WHERE batch_id=?)',[fixture.bid]);
  for(const table of ['legacy_pdf_stage_jobs','legacy_pdf_pages','legacy_pdf_papers','legacy_pdf_jobs','legacy_pdf_batch_locators'])await q('DELETE FROM '+table+' WHERE batch_id=?',[fixture.bid]);
  await q('DELETE FROM legacy_pdf_batches WHERE id=?',[fixture.bid]);await q('DELETE FROM exams WHERE id=?',[fixture.eid]);
  for(const teacher of fixture.teachers)await q('DELETE FROM users WHERE id=?',[teacher.id]);
  assert(/^[0-9a-f-]{36}$/.test(fixture.bid));fs.rmSync('/app/data/answer-card/legacy-pdf/batches/'+fixture.bid,{recursive:true,force:true});fs.rmSync('/app/data/answer-card/subjective-first-fixture.json',{force:true});
 }
 try{
  await wait(async()=>{try{const r=await fetch(base+'/auth/me');return r.status===401||r.status===200;}catch{return false}},'server recovery ready');
  const checkpoint=JSON.parse(fs.readFileSync('/app/data/answer-card/subjective-first-recovery-checkpoint.json'));
  fixture=checkpoint.fixture;for(const t of fixture.teachers)delete t.cookie;
  const login=await api('/auth/login',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD},'');ok(login);admin=login.cookie;cookies.push(admin);
  const [job]=await q("SELECT * FROM legacy_pdf_stage_jobs WHERE id=?",[checkpoint.job.id]);
  assert.equal(job.status,'queued');assert.equal(job.input_hash,checkpoint.job.input_hash);assert.equal(job.payload_json,checkpoint.job.payload_json);
  assert.equal((await q("SELECT objective_paused FROM legacy_pdf_batches WHERE id=?",[fixture.bid]))[0].objective_paused,1);
  assert.equal((await q("SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE kind='objective' AND input_hash=?",[job.input_hash]))[0].n,1);
  const first=fixture.papers[0].id;
  assert.deepEqual(await q("SELECT id,score,version,status FROM legacy_pdf_marks WHERE paper_id=? ORDER BY id",[first]),checkpoint.marks);
  assert.deepEqual(await q("SELECT question_id,final_value,final_source FROM legacy_pdf_results WHERE paper_id=? AND question_id IN('q1','q2','q3') ORDER BY question_id",[first]),checkpoint.manual);
  await q("UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE id=?",[job.id]);
  ok(await api('/scan-batches/'+fixture.bid+'/objective-control',{action:'resume'}));
  await wait(async()=>{const [j]=await q("SELECT status,error FROM legacy_pdf_stage_jobs WHERE id=?",[job.id]);if(j.status==='failed')throw Error(j.error);return j.status==='done'},'recovered objective finish');
  assert.deepEqual(await q("SELECT id,score,version,status FROM legacy_pdf_marks WHERE paper_id=? ORDER BY id",[first]),checkpoint.marks);
  assert.deepEqual(await q("SELECT question_id,final_value,final_source FROM legacy_pdf_results WHERE paper_id=? AND question_id IN('q1','q2','q3') ORDER BY question_id",[first]),checkpoint.manual);
  const report={restartPreservesPause:true,persistentTaskIdAndInput:true,noDuplicateTask:true,manualAndUnknownAnswersPreserved:true,teacherMarksAndVersionsPreserved:true,recoveredTaskCompletes:true};
  fs.writeFileSync('/app/data/answer-card/subjective-first-recovery-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
  await cleanup();fixture=null;fs.rmSync('/app/data/answer-card/subjective-first-recovery-checkpoint.json',{force:true});
 }finally{for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
