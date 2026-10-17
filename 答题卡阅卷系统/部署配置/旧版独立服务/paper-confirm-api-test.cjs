const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{const e=process.env;assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
const cookie=fs.readFileSync('/tmp/paper-confirm-cookie','utf8').trim(),uid=()=>crypto.randomUUID(),bid=uid(),pid=uid();let eid;
const query=async(s,a=[])=>{const [r]=await c.execute(s,a);return r};
const request=async(p,body,method='POST')=>{const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
try{
const catalog=await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id');
const [t]=await query("SELECT * FROM legacy_pdf_templates WHERE id='0c50a3a3-ce7c-48fc-a01c-ceb9c0cfac96'"),def=JSON.parse(t.definition_json);
const [keys]=await query('SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=22'),answers=JSON.parse(keys.answers_json);
const [student]=await query('SELECT student_id FROM exam_participants WHERE exam_id=22 LIMIT 1');
eid=(await query("INSERT INTO exams(name,card_id,grade_id,subject,exam_mode,created_by) VALUES(?,?,1,'英语','formal',1)",['[test] optional objective review '+bid,t.card_id])).insertId;
await query("INSERT INTO exam_participants(exam_id,student_id,source) VALUES(?,?,'roster')",[eid,student.student_id]);
await query('INSERT INTO legacy_pdf_exam_keys(exam_id,answers_json,updated_by) VALUES(?,?,1)',[eid,JSON.stringify(answers)]);
await query("INSERT INTO legacy_pdf_batches(id,exam_id,template_id,pdf_hash,pdf_path,original_name,status,total,finished,created_by) VALUES(?,?,?,?,?,'optional-review-test.pdf','ready',2,2,1)",[bid,eid,t.id,crypto.createHash('sha256').update(bid).digest('hex'),'/test/no-pdf']);
await query("INSERT INTO legacy_pdf_papers(id,batch_id,sheet_no) VALUES(?,?,1)",[pid,bid]);
for(let i=0;i<def.pages.length;i++)await query("INSERT INTO legacy_pdf_pages(id,batch_id,paper_id,source_page,page_role,raw_path,status) VALUES(?,?,?,?,?,'/test/no-image','recognized')",[uid(),bid,pid,i+1,def.pages[i].pageRole]);
const objective=def.questions.filter(q=>q.gradingType==='objective');
for(const q of objective){const value=q.questionId==='q5'?['A','B']:[];await query("INSERT INTO legacy_pdf_results(id,paper_id,question_id,auto_value) VALUES(?,?,?,?)",[uid(),pid,q.questionId,JSON.stringify({status:q.questionId==='q5'?'multiple':'blank',value})])}
let [paper]=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[pid]);
const confirmed=await request('/scan-batches/'+bid+'/papers/'+pid+'/confirm',{studentId:student.student_id,version:paper.version});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
let [r]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q5'",[pid]);assert.equal(Number(r.score),0);assert.equal(r.final_value,'["A","B"]');assert.equal(r.status,'confirmed');
assert.equal((await query("SELECT COUNT(*) n FROM legacy_pdf_results WHERE paper_id=? AND status='confirmed'",[pid]))[0].n,objective.length);
[paper]=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[pid]);
const oldVersion=r.version;assert.equal((await request('/scan-batches/'+bid+'/papers/'+pid+'/confirm',{studentId:student.student_id,version:paper.version})).status,200);
assert.equal((await query("SELECT version FROM legacy_pdf_results WHERE id=?",[r.id]))[0].version,oldVersion);
const invalid=await request('/scan-batches/'+bid+'/papers/'+pid+'/confirm',{studentId:student.student_id,version:paper.version,answers:{q5:['H']}});assert.equal(invalid.status,400);
const stale=await request('/scan-batches/'+bid+'/papers/'+pid+'/confirm',{studentId:student.student_id,version:-1});assert.equal(stale.status,409);
const generation=await request('/scan-batches/'+bid+'/generate',{});assert.equal(generation.status,200,JSON.stringify(generation.data));
[paper]=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[pid]);
const edited=await request('/scan-batches/'+bid+'/papers/'+pid+'/confirm',{studentId:student.student_id,version:paper.version,answers:{q5:answers.q5}});assert.equal(edited.status,200,JSON.stringify(edited.data));
[r]=await query("SELECT * FROM legacy_pdf_results WHERE paper_id=? AND question_id='q5'",[pid]);const max=def.questions.find(q=>q.questionId==='q5').maxScore;assert.equal(Number(r.score),max);
assert.equal((await query('SELECT score FROM question_scores WHERE exam_id=? AND question_number=5',[eid]))[0].score,max);
assert.equal((await query('SELECT total_score FROM student_scores WHERE exam_id=?',[eid]))[0].total_score,null);
assert.deepEqual(await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id'),catalog);
console.log(JSON.stringify({singleMultiFillNo400:true,multiFillZero:true,blankAccepted:true,noManualObjectiveReviewRequired:true,repeatedConfirmationIdempotent:true,invalidOptionStill400:true,staleVersionStill409:true,objectiveEditableAfterTasks:true,incompleteTotalNotPublished:true,templatesUnchanged:true}));
}finally{
if(eid){await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT id FROM legacy_pdf_results WHERE paper_id=?)',[pid]);await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (SELECT id FROM legacy_pdf_marks WHERE paper_id=?)',[pid]);
for(const table of ['question_scores','student_scores','exam_participants','exam_class_snapshots','exam_lifecycle_events','exam_answer_keys','legacy_pdf_exam_keys','answer_block_crops']){try{await query('DELETE FROM '+table+' WHERE exam_id=?',[eid])}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e}}
await query('DELETE FROM legacy_pdf_marks WHERE paper_id=?',[pid]);await query('DELETE FROM legacy_pdf_results WHERE paper_id=?',[pid]);await query('DELETE FROM legacy_pdf_pages WHERE batch_id=?',[bid]);await query('DELETE FROM legacy_pdf_papers WHERE batch_id=?',[bid]);await query('DELETE FROM legacy_pdf_jobs WHERE batch_id=?',[bid]);await query('DELETE FROM legacy_pdf_batches WHERE id=?',[bid]);await query('DELETE FROM legacy_pdf_audit WHERE entity_id IN (?,?,?)',[bid,pid,String(eid)]);await query('DELETE FROM exams WHERE id=?',[eid]);
}await c.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
