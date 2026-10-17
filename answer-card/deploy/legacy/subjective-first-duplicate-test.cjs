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
  await wait(async()=>{try{const r=await fetch(base+'/auth/me');return r.status===401||r.status===200;}catch{return false}},'server ready');
  const login=await api('/auth/login',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD},'');ok(login);admin=login.cookie;cookies.push(admin);
  const [t]=await q("SELECT * FROM legacy_pdf_templates WHERE id='efb6bbfc-8036-45d1-a1be-00c68bb659cf'"),def=JSON.parse(t.definition_json),[source]=await q("SELECT * FROM legacy_pdf_batches WHERE id='3d2fd1ae-39d4-41b1-992b-d09aae6242aa'");
  const templateCount=(await q('SELECT COUNT(*) n FROM legacy_pdf_templates'))[0].n,keys=JSON.parse((await q('SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=21'))[0].answers_json);
  const participants=await q('SELECT student_id FROM legacy_pdf_papers WHERE batch_id=? AND sheet_no IN(1,2) ORDER BY sheet_no',[source.id]);
  fixture={eid:(await q("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by,status) VALUES(?,?,1,'语文','formal',1,'grading')",['[test] subjective-first '+uid(),t.card_id])).insertId,bid:null,teachers:[],papers:[]};
  for(const p of participants)await q("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[fixture.eid,p.student_id]);
  const teacherPassword=uid(),hash=await bcrypt.hash(teacherPassword,10);
  for(let i=0;i<2;i++){const name='subjective_test_'+uid(),id=(await q("INSERT INTO users(username,password_hash,name,role_id,subject,is_active) VALUES(?,?,?,2,'语文',1)",[name,hash,name])).insertId;fixture.teachers.push({id,name});}
  fs.writeFileSync('/app/data/answer-card/subjective-first-fixture.json',JSON.stringify(fixture),{mode:0o600});
  const dir='/app/data/answer-card/subjective-first-test-pdf';fs.mkdirSync(dir,{recursive:true});
  execFileSync('pdfseparate',['-f','1','-l','4',source.pdf_path,dir+'/p-%d.pdf']);execFileSync('pdfunite',[...Array.from({length:4},(_,i)=>dir+'/p-'+(i+1)+'.pdf'),dir+'/sample.pdf']);
  const form=new FormData();form.append('file',new Blob([fs.readFileSync(dir+'/sample.pdf')],{type:'application/pdf'}),'subjective-first-test.pdf');form.append('templateId',t.id);form.append('examId',String(fixture.eid));
  const uploads=await Promise.all([0,1].map(async()=>{const fd=new FormData();fd.append('file',new Blob([fs.readFileSync(dir+'/sample.pdf')],{type:'application/pdf'}),'subjective-first-test.pdf');fd.append('templateId',t.id);fd.append('examId',String(fixture.eid));const r=await fetch(base+'/scan-batches',{method:'POST',headers:{Cookie:admin},body:fd});return {status:r.status,data:await r.json()}}));
  assert(uploads.every(r=>r.status===200||r.status===202),JSON.stringify(uploads));assert.equal(uploads[0].data.id,uploads[1].data.id);fixture.bid=uploads[0].data.id;
  fixture.papers=await q('SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY sheet_no',[fixture.bid]);fs.writeFileSync('/app/data/answer-card/subjective-first-fixture.json',JSON.stringify(fixture),{mode:0o600});
  assert.equal((await q('SELECT COUNT(*) n FROM legacy_pdf_batches WHERE exam_id=?',[fixture.eid]))[0].n,1);
  assert.equal((await q('SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=?',[fixture.bid]))[0].n,4);
  assert.equal((await q('SELECT COUNT(*) n FROM legacy_pdf_pages WHERE batch_id=?',[fixture.bid]))[0].n,4);
  assert.equal((await q('SELECT COUNT(*) n FROM legacy_pdf_templates'))[0].n,templateCount);
  const [page]=await q('SELECT * FROM legacy_pdf_pages WHERE batch_id=? ORDER BY source_page LIMIT 1',[fixture.bid]);
  fs.mkdirSync(require('path').dirname(page.raw_path),{recursive:true});fs.writeFileSync(page.raw_path,Buffer.alloc(0));
  await q("UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE page_id=?",[page.id]);
  await wait(async()=>{const [p]=await q('SELECT status FROM legacy_pdf_pages WHERE id=?',[page.id]);return p.status==='recognized'},'corrupt cached page recovered');
  const meta=await require('/app/node_modules/sharp')(page.raw_path).metadata();assert(meta.width>100&&meta.height>100);
  assert.equal(JSON.parse((await q('SELECT recognition_json FROM legacy_pdf_pages WHERE id=?',[page.id]))[0].recognition_json).questions.length,0);
  const report={concurrentDuplicateUploadOneBatch:true,oneTaskPerPage:true,noTemplateCreated:true,corruptDerivedPageRegeneratedFromOriginal:true,recoveryStillDefersObjectives:true};await cleanup();fixture=null;
  fs.writeFileSync('/app/data/answer-card/subjective-first-duplicate-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
