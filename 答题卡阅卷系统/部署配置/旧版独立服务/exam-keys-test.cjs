const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{const e=process.env;assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
const cookie=fs.readFileSync('/tmp/exam-keys-test-cookie.tmp','utf8').trim(),qid=()=>crypto.randomUUID(),bid=qid(),pid=qid(),rid=qid(),pgids=[];let eid;
const query=async(s,a=[])=>{const [r]=await c.execute(s,a);return r};
const request=async(p,body,method='PUT')=>{const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
try{
const templatesBefore=await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id');
const [t]=await query("SELECT * FROM legacy_pdf_templates WHERE id='0c50a3a3-ce7c-48fc-a01c-ceb9c0cfac96'");const def=JSON.parse(t.definition_json);
const [student]=await query('SELECT student_id FROM exam_participants WHERE exam_id=22 LIMIT 1');
const inserted=await query("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by) VALUES(?,?,1,'英语','formal',1)",['[test] exam-specific keys '+bid,t.card_id]);eid=inserted.insertId;
await query("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[eid,student.student_id]);
await query("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,status,total,finished,created_by) VALUES(?,?,?,?,?,'exam-key-test.pdf','ready',2,2,1)",[bid,eid,t.id,crypto.createHash('sha256').update(bid).digest('hex'),'/test/no-pdf']);
await query("INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no,student_id,identity_status,ownership_confirmed) VALUES(?,?,1,?,'confirmed',1)",[pid,bid,student.student_id]);
for(let i=0;i<def.pages.length;i++){const pg=qid();pgids.push(pg);await query("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path,status) VALUES(?,?,?,?,?,'/test/no-image','recognized')",[pg,bid,pid,i+1,def.pages[i].pageRole])}
await query("INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value,final_value,status,score) VALUES(?,?,'q1','{}','[\"A\"]','confirmed',NULL)",[rid,pid]);
await query("UPDATE legacy_pdf_batches SET answer_key_json=? WHERE id=?",[JSON.stringify({q1:['B']}),bid]);
await query("INSERT INTO exam_answer_keys(exam_id,question_number,answer_text,updated_by) VALUES(?,1,'A',1)",[eid]);
const legacy=await request('/scan-batches/'+bid,undefined,'GET');assert.deepEqual(legacy.data.template.definition.questions.find(q=>q.questionId==='q1').answer,['B']);
const first=await request('/scan-batches/exams/'+eid+'/answer-key',{answers:{q1:['A']}});assert.equal(first.status,200);
let [r]=await query('SELECT * FROM legacy_pdf_results WHERE id=?',[rid]);assert.equal(Number(r.score),1);assert.equal(r.final_value,'["A"]');assert.equal(r.status,'confirmed');
const changed=await request('/scan-batches/exams/'+eid+'/answer-key',{answers:{q1:['B']}});assert.equal(changed.status,200);[r]=await query('SELECT * FROM legacy_pdf_results WHERE id=?',[rid]);assert.equal(Number(r.score),0);assert.equal(r.final_value,'["A"]');
const version=r.version;const repeat=await request('/scan-batches/exams/'+eid+'/answer-key',{answers:{q1:['B']}});assert.equal(repeat.data.unchanged,true);assert.equal((await query('SELECT version FROM legacy_pdf_results WHERE id=?',[rid]))[0].version,version);
const invalid=await request('/scan-batches/exams/'+eid+'/answer-key',{answers:{q1:['H']}});assert.equal(invalid.status,400);
const cleared=await request('/scan-batches/'+bid+'/answer-key',{answers:{q1:null}});assert.equal(cleared.status,200);[r]=await query('SELECT * FROM legacy_pdf_results WHERE id=?',[rid]);assert.equal(r.score,null);assert.equal(r.status,'confirmed');assert.equal(r.final_value,'["A"]');
const blocked=await request('/scan-batches/'+bid+'/generate',{},'POST');assert.equal(blocked.status,409);
const refs=await request('/exams/'+eid+'/answer-key',{answers:[{questionNumber:1,answerText:'A',pageIndex:null}]});assert.equal(refs.status,200);[r]=await query('SELECT * FROM legacy_pdf_results WHERE id=?',[rid]);assert.equal(Number(r.score),1);
const read=await request('/scan-batches/'+bid,undefined,'GET');assert.deepEqual(read.data.template.definition.questions.find(q=>q.questionId==='q1').answer,['A']);
const examOriginal=await query('SELECT card_id FROM exams WHERE id=?',[eid]);assert.equal(examOriginal[0].card_id,t.card_id);
assert.deepEqual(await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id'),templatesBefore);
const other=await request('/scan-batches/exams/22/answer-key',undefined,'GET');assert.deepEqual(other.data.definition.questions.find(q=>q.questionId==='q1').answer,['C']);
console.log(JSON.stringify({existingBatchKeyPreservedUntilExplicitSave:true,saveWithoutNewTemplate:true,examCardUnchanged:true,confirmedAnswersPreserved:true,rescoringWorks:true,repeatedSaveIdempotent:true,invalidKeyRejected:true,clearKeepsScoreIncomplete:true,referenceEditorUsesSameKeys:true,otherExamUnaffected:true}));
}finally{if(eid){for(const table of ['question_scores','student_scores','exam_participants','exam_class_snapshots','exam_lifecycle_events','exam_answer_keys','legacy_pdf_exam_keys']){try{await query('DELETE FROM '+table+' WHERE exam_id=?',[eid])}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e}}
await query('DELETE FROM legacy_pdf_results WHERE paper_id=?',[pid]);await query('DELETE FROM legacy_pdf_pages WHERE batch_id=?',[bid]);await query('DELETE FROM legacy_pdf_papers WHERE batch_id=?',[bid]);await query('DELETE FROM legacy_pdf_batches WHERE id=?',[bid]);
await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN ('+[bid,pid,rid,String(eid),...pgids].map(()=>'?').join(',')+')',[bid,pid,rid,String(eid),...pgids]);await query('DELETE FROM exams WHERE id=?',[eid]);}await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
