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
  await wait(async()=>!(await q("SELECT id FROM legacy_pdf_stage_jobs WHERE batch_id=? AND status='running'",[fixture.bid])).length,'fixture worker finish');
  await q("UPDATE legacy_pdf_stage_jobs SET status='cancelled' WHERE batch_id=? AND status IN('queued','failed')",[fixture.bid]);
  for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});
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
  const started=Date.now(),upload=await fetch(base+'/scan-batches',{method:'POST',headers:{Cookie:admin},body:form});const batch=await upload.json();assert.equal(upload.status,202,JSON.stringify(batch));fixture.bid=batch.id;
  fixture.papers=await q('SELECT * FROM legacy_pdf_papers WHERE batch_id=? ORDER BY sheet_no',[fixture.bid]);fs.writeFileSync('/app/data/answer-card/subjective-first-fixture.json',JSON.stringify(fixture),{mode:0o600});
  const path='/scan-batches/'+fixture.bid;
  ok(await api(path+'/objective-mode',{mode:'manual'},admin,'PUT'));ok(await api('/scan-batches/exams/'+fixture.eid+'/answer-key',{answers:Object.fromEntries(def.questions.filter(q=>q.gradingType==='objective').map(q=>[q.questionId,null]))},admin,'PUT'));
  await q("UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE batch_id=? AND paper_id=?",[fixture.bid,fixture.papers[0].id]);
  await wait(async()=>(await q("SELECT COUNT(*) n FROM legacy_pdf_pages WHERE paper_id=? AND status='recognized'",[fixture.papers[0].id]))[0].n===2,'first paper preprocessing');
  const first=fixture.papers[0].id,second=fixture.papers[1].id,[paper]=await q('SELECT * FROM legacy_pdf_papers WHERE id=?',[first]);
  assert((await q('SELECT auto_value,final_value FROM legacy_pdf_results WHERE paper_id=?',[first])).every(r=>r.auto_value===null&&r.final_value===null));
  ok(await api(path+'/papers/'+first+'/confirm',{version:paper.version,studentId:participants[0].student_id,answers:{}}));
  const generated=ok(await api(path+'/generate',{}));assert.equal(generated.generated,1);assert.equal(generated.skipped.length,1);assert.equal(generated.count,9);
  const firstTeacherReadyMs=Date.now()-started;
  const again=ok(await api(path+'/generate',{paperIds:[first]}));assert.equal(again.count,0);assert.equal(again.existing,1);
  assert.equal((await q("SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[fixture.bid]))[0].n,0);
  let marks=await q('SELECT m.*,c.block_id FROM legacy_pdf_marks m JOIN answer_block_crops c ON c.id=m.crop_id WHERE m.paper_id=? ORDER BY m.question_id',[first]);
  const firstBlockForImage=marks[0].id;const imageResponse=await fetch(base+path+'/marks/'+firstBlockForImage+'/image',{headers:{Cookie:admin}});assert.equal(imageResponse.status,200);const imageMeta=await require('/app/node_modules/sharp')(Buffer.from(await imageResponse.arrayBuffer())).metadata();assert(imageMeta.width>10&&imageMeta.height>10);
  for(const m of marks.slice(0,2))for(const teacher of fixture.teachers)await q('INSERT INTO review_assignments(exam_id,block_id,teacher_id,student_count,assigned_student_ids) VALUES(?,?,?,1,?)',[fixture.eid,m.block_id,teacher.id,JSON.stringify([participants[0].student_id])]);
  for(const teacher of fixture.teachers){const login=await api('/auth/login',{identifier:teacher.name,password:teacherPassword},'');ok(login);teacher.cookie=login.cookie;cookies.push(login.cookie);}
  const firstBlock=marks[0].block_id;
  const claims=await Promise.all(fixture.teachers.map(t=>api(path+'/marks/'+marks[0].id+'/claim',{},t.cookie)));
  assert.equal(claims.filter(r=>r.status===200).length,1);const winner=fixture.teachers[claims.findIndex(r=>r.status===200)],other=fixture.teachers.find(t=>t.id!==winner.id);
  ok(await api(path+'/marks/'+marks[1].id+'/claim',{},other.cookie));
  assert.equal((await api(path+'/marks/'+marks[0].id+'/score',{score:999,version:0},winner.cookie,'PUT')).status,422);
  const score1=ok(await api(path+'/marks/'+marks[0].id+'/score',{score:1,version:0},winner.cookie,'PUT'));assert.equal(score1.paperTotalScore,null);
  ok(await api(path+'/marks/'+marks[1].id+'/score',{score:2,version:0},other.cookie,'PUT'));
  assert.equal(ok(await api(path+'/marks/'+marks[0].id+'/score',{score:1,version:0},winner.cookie,'PUT')).reused,true);
  assert.equal((await api(path+'/papers/'+first+'/swap-faces',{requestId:uid(),version:(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[first]))[0].version,pages:(await q('SELECT id,version FROM legacy_pdf_pages WHERE paper_id=?',[first]))})).status,409);
  let current=(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[first]))[0];
  ok(await api(path+'/papers/'+first+'/confirm',{version:current.version,studentId:participants[0].student_id,answers:{q1:[],q2:['C']}}));
  await q("UPDATE legacy_pdf_results SET final_source='legacy_unknown',final_value='[\"C\"]',status='confirmed' WHERE paper_id=? AND question_id='q3'",[first]);
  ok(await api(path+'/objective-control',{action:'start'}));ok(await api(path+'/objective-control',{action:'pause'}));
  const [j]=await q("SELECT * FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[fixture.bid]);
  for(const teacher of fixture.teachers)delete teacher.cookie;
  const checkpoint={fixture,job:{id:j.id,input_hash:j.input_hash,payload_json:j.payload_json},marks:await q("SELECT id,score,version,status FROM legacy_pdf_marks WHERE paper_id=? ORDER BY id",[first]),manual:await q("SELECT question_id,final_value,final_source FROM legacy_pdf_results WHERE paper_id=? AND question_id IN('q1','q2','q3') ORDER BY question_id",[first])};
  fs.writeFileSync('/app/data/answer-card/subjective-first-recovery-checkpoint.json',JSON.stringify(checkpoint),{mode:0o600});console.log(JSON.stringify({checkpointPrepared:true,objectivePaused:true}));
 }finally{for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
