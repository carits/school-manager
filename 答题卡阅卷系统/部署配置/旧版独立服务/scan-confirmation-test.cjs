const fs=require('fs'),crypto=require('crypto'),assert=require('assert/strict'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 const query=async(sql,args=[])=>{const [x]=await c.execute(sql,args);return x},id=()=>crypto.randomUUID();
 const request=async(p,body,method='POST')=>{const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:cookie,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});const data=await r.json();return {status:r.status,data}};
 const bid=id(),pids=[],rids=[],pgids=[];let eid;let output;
 try{
 const before=await query('SELECT COUNT(*) n FROM legacy_pdf_templates');
 const [t]=await query("SELECT * FROM legacy_pdf_templates WHERE id='f69cc4db-c36d-4d1a-887e-88731b4d40d3'");assert(t);
 const def=JSON.parse(t.definition_json),qs=def.questions.filter(q=>q.gradingType==='objective');
 const students=await query('SELECT ep.student_id FROM exam_participants ep WHERE ep.exam_id=22 ORDER BY ep.student_id LIMIT 6');assert.equal(students.length,6);
 const inserted=await query("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by) VALUES(?,?,1,'英语','formal',1)",['[test] normal confirmation '+bid,t.card_id]);eid=inserted.insertId;
 for(const s of students)await query("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[eid,s.student_id]);
 await query("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,status,total,finished,created_by) VALUES(?,?,?,?,?,'normal-confirmation-test.pdf','ready',13,13,1)",[bid,eid,t.id,crypto.createHash('sha256').update(bid).digest('hex'),'/test/no-pdf']);
 for(let i=0;i<7;i++){
 const pid=id();pids.push(pid);const student=students[[0,1,2,2,3,4,5][i]].student_id;
 const identity={status:'candidate',studentId:student,confidence:i===4?.4:1,studentNumber:'test'+i,name:'Fixture '+i};
 await query('INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no,student_id,auto_identity,identity_status,ownership_confirmed) VALUES(?,?,?,?,?,?,?)',[pid,bid,i+1,i===1?student:null,JSON.stringify(identity),i===1?'confirmed':'wait_confirm',i===1?1:0]);
 for(let j=0;j<(i===5?1:def.pages.length);j++){const pg=id();pgids.push(pg);await query("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path,status) VALUES(?,?,?,?,?,'/test/no-image','recognized')",[pg,bid,pid,i*2+j+1,def.pages[j].pageRole]);}
 for(const q of qs){
 const rid=id();rids.push(rid);const normal=q.questionId==='q1'||(q.questionId==='q2'&&(i===1||i===6)),auto={status:normal?'recognized':'ambiguous',value:normal?q.answer:['A'],confidence:normal?1:.1};
 const manual=i===1&&q.questionId==='q1',stale=i===6&&q.questionId==='q3';
 await query('INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value,final_value,status,score) VALUES(?,?,?,?,?,?,?)',[rid,pid,q.questionId,JSON.stringify(auto),manual||stale?'["A"]':null,manual?'confirmed':'wait_confirm',manual?0:null]);
 }
 }
 const first=await request('/scan-batches/'+bid+'/confirm-normal',{});assert.equal(first.status,200);assert.equal(first.data.confirmedIdentities,2);assert.equal(first.data.confirmedResults,4);assert.equal(first.data.skipped.length,7);
 const rows=await query('SELECT p.sheet_no,r.* FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id=?',[bid]);
 assert.equal(rows.filter(r=>r.status==='confirmed').length,5);
 const manual=rows.find(r=>r.sheet_no===2&&r.question_id==='q1');assert.equal(manual.final_value,'["A"]');assert.equal(Number(manual.score),0);
 const stale=rows.find(r=>r.sheet_no===7&&r.question_id==='q3');assert.equal(stale.final_value,'["A"]');assert.equal(stale.status,'wait_confirm');
 for(const i of [3,4,5,6])assert(rows.filter(r=>r.sheet_no===i).every(r=>r.status==='wait_confirm'));
 const auditBefore=(await query('SELECT COUNT(*) n FROM legacy_pdf_audit WHERE entity_id IN ('+[bid,...pids,...rids].map(()=>'?').join(',')+')',[bid,...pids,...rids]))[0].n;
 const repeat=await request('/scan-batches/'+bid+'/confirm-normal',{});assert.equal(repeat.data.confirmedResults,0);assert.equal(repeat.data.confirmedIdentities,0);
 const auditAfter=(await query('SELECT COUNT(*) n FROM legacy_pdf_audit WHERE entity_id IN ('+[bid,...pids,...rids].map(()=>'?').join(',')+')',[bid,...pids,...rids]))[0].n;assert.equal(auditBefore,auditAfter);
 const blocked=await request('/scan-batches/'+bid+'/generate',{});assert.equal(blocked.status,409);
 const answers=Object.fromEntries(qs.map(q=>[q.questionId,q.answer]));
 const confirmed=await request('/scan-batches/'+bid+'/papers/'+pids[0]+'/confirm',{studentId:students[0].student_id,answers,version:1});assert.equal(confirmed.status,200);
 assert.equal((await query("SELECT COUNT(*) n FROM legacy_pdf_results WHERE paper_id=? AND status='confirmed'",[pids[0]]))[0].n,45);
 const [real]=await query("SELECT * FROM legacy_pdf_batches WHERE id='3d2fd1ae-39d4-41b1-992b-d09aae6242aa'");
 const batchCount=(await query('SELECT COUNT(*) n FROM legacy_pdf_batches'))[0].n;
 const form=new FormData();form.append('file',new Blob([fs.readFileSync(real.pdf_path)],{type:'application/pdf'}),'duplicate-scan.pdf');form.append('templateId',real.template_id);form.append('examId',String(real.exam_id));
 const duplicate=await request('/scan-batches',form);assert.equal(duplicate.status,202);assert.equal(duplicate.data.id,real.id);assert.equal(duplicate.data.reused,true);
 assert.equal((await query('SELECT COUNT(*) n FROM legacy_pdf_templates'))[0].n,before[0].n);assert.equal((await query('SELECT COUNT(*) n FROM legacy_pdf_batches'))[0].n,batchCount);
 output={partialNormalConfirmation:first.data.confirmedResults,normalIdentities:first.data.confirmedIdentities,anomaliesRemainPending:true,duplicateIdentitiesRejected:true,lowConfidenceIdentityRejected:true,missingPageRejected:true,manualConfirmedResultPreserved:true,staleFinalRequiresManualReview:true,repeatedConfirmationIdempotent:true,manualConfirmationWorks:true,incompleteTaskGenerationBlocked:true,duplicateUploadReusesBatch:true,scanDoesNotCreateTemplate:true};
 }finally{
 if(eid){for(const table of ['question_scores','student_scores','exam_participants','exam_class_snapshots','exam_lifecycle_events']){try{await query('DELETE FROM '+table+' WHERE exam_id=?',[eid])}catch(err){if(err.code!=='ER_NO_SUCH_TABLE')throw err}}
 for(const pid of pids){await query('DELETE FROM legacy_pdf_results WHERE paper_id=?',[pid]);await query('DELETE FROM legacy_pdf_pages WHERE paper_id=?',[pid]);await query('DELETE FROM legacy_pdf_papers WHERE id=?',[pid])}
 const ids=[bid,...pids,...rids,...pgids];await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN ('+ids.map(()=>'?').join(',')+')',ids);
 await query('DELETE FROM legacy_pdf_batches WHERE id=?',[bid]);await query('DELETE FROM exams WHERE id=?',[eid]);}
 await c.end();
 }
 console.log(JSON.stringify(output));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
