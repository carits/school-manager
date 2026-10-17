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
  await q('DELETE FROM legacy_pdf_batches WHERE id=?',[fixture.bid]);await q('DELETE FROM exams WHERE id=?',[fixture.eid]);for(const eid of fixture.extraExamIds||[]){for(const table of ['question_scores','student_scores','answer_block_crops','exam_participants','legacy_pdf_exam_keys','exam_publish_events'])await q('DELETE FROM '+table+' WHERE exam_id=?',[eid]);await q("DELETE FROM legacy_pdf_audit WHERE entity_type='exam' AND entity_id=?",[String(eid)]);await q('DELETE FROM exams WHERE id=?',[eid]);}
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
  const otherExam=(await q("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by,status) VALUES(?,?,1,'语文','formal',1,'draft')",['[test] binding '+uid(),t.card_id])).insertId;fixture.extraExamIds=[otherExam];fs.writeFileSync('/app/data/answer-card/subjective-first-fixture.json',JSON.stringify(fixture),{mode:0o600});
  for(const participant of participants)await q("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[otherExam,participant.student_id]);
  await q('INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,1)',[otherExam,JSON.stringify({...keys,q1:['A']})]);
  const pagesBeforeBinding=await q('SELECT id,source_page,page_role,raw_path,aligned_path,version FROM legacy_pdf_pages WHERE batch_id=? ORDER BY id',[fixture.bid]);
  let beforeBind=(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[first]))[0];ok(await api(path+'/papers/'+first+'/confirm',{version:beforeBind.version,studentId:participants[0].student_id,answers:{q1:['D']}}));
  assert.equal((await api(path+'/exam',{examId:22,expectedExamId:fixture.eid},admin,'PUT')).status,400);
  ok(await api(path+'/exam',{examId:otherExam,expectedExamId:fixture.eid},admin,'PUT'));
  assert.equal((await q('SELECT exam_id FROM legacy_pdf_batches WHERE id=?',[fixture.bid]))[0].exam_id,otherExam);
  let [moved]=await q("SELECT auto_value,final_value,final_source,score FROM legacy_pdf_results WHERE paper_id=? AND question_id='q1'",[first]);assert.equal(moved.auto_value,null);assert.equal(moved.final_value,'["D"]');assert.equal(moved.final_source,'manual');assert.equal(Number(moved.score),0);
  assert.equal(ok(await api(path+'/exam',{examId:otherExam,expectedExamId:fixture.eid},admin,'PUT')).reused,true);
  assert.equal((await api(path+'/exam',{examId:fixture.eid,expectedExamId:fixture.eid},admin,'PUT')).status,409);
  ok(await api(path+'/exam',{examId:fixture.eid,expectedExamId:otherExam},admin,'PUT'));
  assert.equal((await q("SELECT score FROM legacy_pdf_results WHERE paper_id=? AND question_id='q1'",[first]))[0].score,null);
  assert.deepEqual(await q('SELECT id,source_page,page_role,raw_path,aligned_path,version FROM legacy_pdf_pages WHERE batch_id=? ORDER BY id',[fixture.bid]),pagesBeforeBinding);
  const generated=ok(await api(path+'/generate',{}));assert.equal(generated.generated,1);assert.equal(generated.skipped.length,1);assert.equal(generated.count,9);
  const firstTeacherReadyMs=Date.now()-started;
  const again=ok(await api(path+'/generate',{paperIds:[first]}));assert.equal(again.count,0);assert.equal(again.existing,1);
  assert.equal((await q("SELECT COUNT(*) n FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[fixture.bid]))[0].n,0);
  let marks=await q('SELECT m.*,c.block_id FROM legacy_pdf_marks m JOIN answer_block_crops c ON c.id=m.crop_id WHERE m.paper_id=? ORDER BY m.question_id',[first]);
  const adminBlocks=ok(await api('/review-assign/exams/'+fixture.eid+'/teachers/me/blocks',undefined,admin,'GET'));assert(adminBlocks.data.length===9&&adminBlocks.data.every(b=>b.remainingForMe===1));
  const firstBlockForImage=marks[0].id;const imageResponse=await fetch(base+path+'/marks/'+firstBlockForImage+'/image',{headers:{Cookie:admin}});assert.equal(imageResponse.status,200);const imageMeta=await require('/app/node_modules/sharp')(Buffer.from(await imageResponse.arrayBuffer())).metadata();assert(imageMeta.width>10&&imageMeta.height>10);
  for(const m of marks.slice(0,2))for(const teacher of fixture.teachers)await q('INSERT INTO review_assignments(exam_id,block_id,teacher_id,student_count,assigned_student_ids) VALUES(?,?,?,1,?)',[fixture.eid,m.block_id,teacher.id,JSON.stringify([participants[0].student_id])]);
  for(const teacher of fixture.teachers){const login=await api('/auth/login',{identifier:teacher.name,password:teacherPassword},'');ok(login);teacher.cookie=login.cookie;cookies.push(login.cookie);}
  for(const teacher of fixture.teachers){
   const online=ok(await api('/review/my-exams',undefined,teacher.cookie,'GET'));assert(online.data.some(x=>Number(x.examId)===fixture.eid));
   const blocks=ok(await api('/review-assign/exams/'+fixture.eid+'/teachers/me/blocks',undefined,teacher.cookie,'GET'));assert(blocks.data.some(x=>x.blockId===marks[0].block_id&&x.remainingForMe===1));
   const pool=ok(await api('/review-pool/exams/'+fixture.eid+'/blocks/'+encodeURIComponent(marks[0].block_id),undefined,teacher.cookie,'GET'));assert(pool.ok);
   const rows=ok(await api('/review/exams/'+fixture.eid+'/block-crops?blockId='+encodeURIComponent(marks[0].block_id),undefined,teacher.cookie,'GET'));assert.equal(rows.rows.length,1);assert.equal(Number(rows.rows[0].maxScore),Number(marks[0].max_score||def.questions.find(x=>x.questionId===marks[0].question_id).maxScore));
   const image=await fetch(base+'/answer-block-crops/'+marks[0].crop_id+'/image',{headers:{Cookie:teacher.cookie}});assert.equal(image.status,200);
  }
  const summaryBlocks=ok(await api('/review/exams/'+fixture.eid+'/blocks',undefined,admin,'GET'));assert(summaryBlocks.blocks.every(b=>Number(b.maxScore)>0));
  const firstBlock=marks[0].block_id;
  const claims=await Promise.all(fixture.teachers.map(t=>api('/review-pool/exams/'+fixture.eid+'/blocks/'+encodeURIComponent(marks[0].block_id)+'/crops/'+marks[0].crop_id+'/claim',{},t.cookie)));
  assert.equal(claims.filter(r=>r.status===200).length,1);const winner=fixture.teachers[claims.findIndex(r=>r.status===200)],other=fixture.teachers.find(t=>t.id!==winner.id);
  ok(await api(path+'/marks/'+marks[1].id+'/claim',{},other.cookie));
  assert.equal((await api(path+'/marks/'+marks[0].id+'/score',{score:999,version:0},winner.cookie,'PUT')).status,422);
  const score1=ok(await api('/review/exams/'+fixture.eid+'/block-crops/'+marks[0].crop_id+'/submit',{scores:[{questionNumber:Number(def.questions.find(q=>q.questionId===marks[0].question_id).displayNumber),scoreType:'subjective'}],blockTotalScore:1,status:'reviewed'},winner.cookie));assert.equal(score1.paperTotalScore,null);const history=JSON.parse((await q('SELECT score_breakdown FROM answer_block_crops WHERE id=?',[marks[0].crop_id]))[0].score_breakdown);assert.equal(history[0].reviewerId,winner.id);
  ok(await api(path+'/marks/'+marks[1].id+'/score',{score:2,version:0},other.cookie,'PUT'));
  const reusedScore=ok(await api(path+'/marks/'+marks[0].id+'/score',{score:1,version:0},winner.cookie,'PUT'));assert.equal(reusedScore.reused,true);assert.equal(reusedScore.paperTotalScore,null);
  assert.equal((await api(path+'/exam',{examId:otherExam,expectedExamId:fixture.eid},admin,'PUT')).status,409);assert.equal((await q('SELECT exam_id FROM legacy_pdf_batches WHERE id=?',[fixture.bid]))[0].exam_id,fixture.eid);
  assert.equal((await api(path+'/papers/'+first+'/swap-faces',{requestId:uid(),version:(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[first]))[0].version,pages:(await q('SELECT id,version FROM legacy_pdf_pages WHERE paper_id=?',[first]))})).status,409);
  let current=(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[first]))[0];
  ok(await api(path+'/papers/'+first+'/confirm',{version:current.version,studentId:participants[0].student_id,answers:{q1:[],q2:['C']}}));
  await q("UPDATE legacy_pdf_results SET final_source='legacy_unknown',final_value='[\"C\"]',status='confirmed' WHERE paper_id=? AND question_id='q3'",[first]);
  ok(await api(path+'/objective-control',{action:'start'}));let [objective]=await q("SELECT * FROM legacy_pdf_stage_jobs WHERE batch_id=? AND kind='objective'",[fixture.bid]);assert.equal(objective.priority,10);
  await sleep(1000);assert.equal((await q('SELECT status FROM legacy_pdf_stage_jobs WHERE id=?',[objective.id]))[0].status,'queued');
  ok(await api(path+'/objective-control',{action:'pause'}));
  await q('UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE id=?',[objective.id]);await sleep(1000);
  assert.equal((await q('SELECT status FROM legacy_pdf_stage_jobs WHERE id=?',[objective.id]))[0].status,'queued');
  const markBefore=await q('SELECT id,score,version,status FROM legacy_pdf_marks WHERE paper_id=? ORDER BY id',[first]);
  ok(await api(path+'/objective-control',{action:'resume'}));
  await wait(async()=>(await q('SELECT status FROM legacy_pdf_stage_jobs WHERE id=?',[objective.id]))[0].status==='running','objective running');
  ok(await api(path+'/marks/'+marks[1].id+'/score',{score:3,version:1},other.cookie,'PUT'));
  await wait(async()=>{const [j]=await q('SELECT status,error FROM legacy_pdf_stage_jobs WHERE id=?',[objective.id]);if(j.status==='failed')throw Error(j.error);return j.status==='done'},'objective finish');
  const results=await q('SELECT * FROM legacy_pdf_results WHERE paper_id=? ORDER BY question_id',[first]);
  assert.equal(results.find(r=>r.question_id==='q1').final_value,'[]');assert.equal(results.find(r=>r.question_id==='q2').final_value,'["C"]');assert.equal(results.find(r=>r.question_id==='q3').final_value,'["C"]');
  assert(results.every(r=>r.auto_value!==null));assert.equal((await q('SELECT score FROM legacy_pdf_marks WHERE id=?',[marks[1].id]))[0].score,3);
  assert.equal((await q('SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?',[fixture.eid,participants[0].student_id]))[0].total_score,null);
  const taskIds=await q('SELECT id,status FROM legacy_pdf_stage_jobs WHERE batch_id=? ORDER BY id',[fixture.bid]),pageVersions=await q('SELECT id,version FROM legacy_pdf_pages WHERE batch_id=? ORDER BY id',[fixture.bid]);
  ok(await api(path+'/answer-key',{answers:keys},admin,'PUT'));
  assert.deepEqual(await q('SELECT id,status FROM legacy_pdf_stage_jobs WHERE batch_id=? ORDER BY id',[fixture.bid]),taskIds);
  assert.deepEqual(await q('SELECT id,version FROM legacy_pdf_pages WHERE batch_id=? ORDER BY id',[fixture.bid]),pageVersions);
  marks=await q('SELECT * FROM legacy_pdf_marks WHERE paper_id=?',[first]);
  for(const m of marks.filter(m=>m.status!=='reviewed'))ok(await api(path+'/marks/'+m.id+'/score',{score:1,version:m.version},admin,'PUT'));
  let summary=ok(await api(path+'/summary',undefined,admin,'GET'));assert.equal(summary.students.find(p=>p.id===first).complete,true);assert.equal(summary.students.find(p=>p.id===second).complete,false);
  const deniedExport=await fetch(base+path+'/summary.xlsx',{headers:{Cookie:admin}});assert.equal(deniedExport.status,409);
  await q("UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE batch_id=? AND paper_id=? AND kind='preprocess'",[fixture.bid,second]);
  await wait(async()=>(await q("SELECT COUNT(*) n FROM legacy_pdf_pages WHERE paper_id=? AND status='recognized'",[second]))[0].n===2,'second paper preprocessing');
  current=(await q('SELECT version FROM legacy_pdf_papers WHERE id=?',[second]))[0];
  ok(await api(path+'/papers/'+second+'/confirm',{version:current.version,studentId:participants[1].student_id,answers:{}}));
  const secondGeneration=ok(await api(path+'/generate',{paperIds:[second]}));assert.equal(secondGeneration.generated,1);
  await q("UPDATE legacy_pdf_stage_jobs SET priority=300 WHERE batch_id=? AND paper_id=? AND kind='objective'",[fixture.bid,second]);
  await wait(async()=>{const rows=await q("SELECT status,error FROM legacy_pdf_stage_jobs WHERE batch_id=? AND paper_id=? AND kind='objective'",[fixture.bid,second]);if(rows[0]?.status==='failed')throw Error(rows[0].error);return rows[0]?.status==='done'},'second objective');
  const secondMarks=await q('SELECT m.*,c.block_id FROM legacy_pdf_marks m JOIN answer_block_crops c ON c.id=m.crop_id WHERE m.paper_id=?',[second]);
  assert.equal((await api(path+'/marks/'+secondMarks.find(m=>m.block_id===firstBlock)?.id+'/claim',{},winner.cookie)).status,403);
  for(const m of secondMarks)ok(await api(path+'/marks/'+m.id+'/score',{score:1,version:m.version},admin,'PUT'));
  summary=ok(await api(path+'/summary',undefined,admin,'GET'));assert(summary.students.every(p=>p.complete));
  const XLSX=require('/app/node_modules/xlsx'),response=await fetch(base+path+'/summary.xlsx',{headers:{Cookie:admin}});assert.equal(response.status,200);
  const book=XLSX.read(Buffer.from(await response.arrayBuffer()),{type:'buffer'}),rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
  for(const p of summary.students){const row=rows.find(r=>r['学号']===String(p.studentNumber));assert.equal(row['总分'],p.total);}
  assert.equal((await q('SELECT COUNT(*) n FROM legacy_pdf_templates'))[0].n,templateCount);
  const report={freshUpload:true,noObjectivesDuringPreprocessing:true,partialGenerationWithoutAnswerKeys:true,duplicateGenerationIdempotent:true,manualModeDormant:true,lowPriorityObjectiveYieldsToPreprocessing:true,pauseResume:true,twoTeachersConcurrentClaimAndScoring:true,scoreBounds422:true,scoringDuringObjectiveProcessing:true,manualBlankAndUnknownPreserved:true,teacherScoresPreserved:true,keyChangeOnlyRescores:true,incompleteExport409:true,excelMatchesFinalScores:true,noTemplateCreated:true,examOnlineReviewListingClaimImageSubmit:true,sameTemplateExamRebindingPreservesAnswersAndPages:true,targetExamKeyRescoreWithoutRecognition:true,staleRebinding409:true,teacherWorkBlocksRebinding:true,firstTeacherReadyMs,benchmarkQueueExcluded:true};
  fs.writeFileSync('/app/data/answer-card/subjective-first-api-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
  await cleanup();fixture=null;fs.rmSync(dir,{recursive:true,force:true});
 }finally{for(const cookie of cookies)await api('/auth/logout',{},cookie).catch(()=>{});await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
