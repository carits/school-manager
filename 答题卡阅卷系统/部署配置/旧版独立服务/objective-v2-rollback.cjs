// Run inside the isolated old service only. Default is a read-only rollback preview.
const mysql=require('/app/node_modules/mysql2/promise'),assert=require('assert/strict');
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');assert.ok(e.OBJECTIVE_RUN_ID);
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 const query=async(s,a=[])=>{const [r]=await c.execute(s,a);return r};
 const [job]=await query("SELECT * FROM legacy_pdf_jobs WHERE run_id=? AND kind='objective'",[e.OBJECTIVE_RUN_ID]);assert.ok(job);assert.ok(!['queued','running'].includes(job.status));
 const [batch]=await query('SELECT * FROM legacy_pdf_batches WHERE id=?',[job.batch_id]);assert.ok(batch);
 const [lock]=await query('SELECT GET_LOCK(?,10) ok',['legacy-batch-'+batch.id]);assert.equal(Number(lock.ok),1);
 let restored=0,preserved=0;
 try{
  await c.beginTransaction();
  await query('SELECT id FROM exams WHERE id=? FOR UPDATE',[batch.exam_id]);
  const [currentJob]=await query('SELECT * FROM legacy_pdf_jobs WHERE batch_id=? FOR UPDATE',[batch.id]);assert.equal(currentJob.run_id,e.OBJECTIVE_RUN_ID);assert.ok(!['queued','running'].includes(currentJob.status));
  const audits=await query("SELECT * FROM legacy_pdf_audit WHERE action='objective_reprocess' AND JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.runId'))=? ORDER BY id DESC",[e.OBJECTIVE_RUN_ID]);
  const seen=new Set(),pages=new Map(),paperIds=new Set();
  for(const a of audits){
   if(seen.has(a.entity_id))continue;seen.add(a.entity_id);
   const after=JSON.parse(a.after_json),before=JSON.parse(a.before_json);
   const [r]=await query('SELECT r.*,p.student_id FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE r.id=? AND p.batch_id=? FOR UPDATE',[a.entity_id,batch.id]);
   if(!r||r.final_source!=='auto'||Number(r.version)!==Number(after.version)){preserved++;continue}
   restored++;if(e.APPLY_ROLLBACK!=='1')continue;
   const value=before.value==null?null:JSON.stringify(before.value),auto=before.auto==null?null:JSON.stringify(before.auto);
   await query('UPDATE legacy_pdf_results SET auto_value=?,final_value=?,score=?,status=?,final_source=?,recognizer_version=?,confidence=?,version=version+1 WHERE id=?',[auto,value,before.score,before.status,before.source||'auto',before.recognizerVersion||null,before.auto?.confidence??null,r.id]);
   const [t]=await query('SELECT definition_json FROM legacy_pdf_templates WHERE id=?',[batch.template_id]),q=JSON.parse(t.definition_json).questions.find(q=>q.questionId===r.question_id);
   if(r.student_id)await query("UPDATE question_scores SET score=?,selected_options=?,modified_by=?,modified_at=CURRENT_TIMESTAMP WHERE exam_id=? AND student_id=? AND question_number=? AND score_type='objective'",[before.score,value,Number(e.ROLLBACK_ACTOR||1),batch.exam_id,r.student_id,Number(q.displayNumber)]);
   await query("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json) VALUES('result',?,'objective_rollback',?,?,?)",[r.id,Number(e.ROLLBACK_ACTOR||1),JSON.stringify(after),JSON.stringify({...before,runId:e.OBJECTIVE_RUN_ID,restoredVersion:Number(r.version)+1})]);
   paperIds.add(r.paper_id);
  }
  if(e.APPLY_ROLLBACK==='1'){
   const [template]=await query('SELECT definition_json FROM legacy_pdf_templates WHERE id=?',[batch.template_id]),def=JSON.parse(template.definition_json);
   for(const pid of paperIds){
    const [p]=await query('SELECT * FROM legacy_pdf_papers WHERE id=?',[pid]),results=await query('SELECT * FROM legacy_pdf_results WHERE paper_id=?',[pid]),marks=await query('SELECT * FROM legacy_pdf_marks WHERE paper_id=?',[pid]);
    const complete=p.identity_status==='confirmed'&&p.ownership_confirmed&&def.questions.every(q=>q.gradingType==='objective'?results.some(r=>r.question_id===q.questionId&&r.status==='confirmed'&&r.score!=null):marks.some(m=>m.question_id===q.questionId&&m.status==='reviewed'&&m.score!=null));
    const objective=results.reduce((s,r)=>s+Number(r.score||0),0),subjective=marks.reduce((s,m)=>s+Number(m.score||0),0);
    await query('UPDATE student_scores SET objective_score=?,subjective_score=?,total_score=? WHERE exam_id=? AND student_id=?',[complete?objective:null,complete?subjective:null,complete?objective+subjective:null,batch.exam_id,p.student_id]);
    await query('UPDATE legacy_pdf_papers SET version=version+1 WHERE id=?',[pid]);
    const pg=await query('SELECT * FROM legacy_pdf_pages WHERE paper_id=?',[pid]);
    for(const page of pg){const rec=JSON.parse(page.recognition_json||'{}');rec.questions=(rec.questions||[]).map(q=>{const r=results.find(r=>r.question_id===q.questionId);return r?JSON.parse(r.auto_value):q});await query('UPDATE legacy_pdf_pages SET recognition_json=? WHERE id=?',[JSON.stringify(rec),page.id])}
   }
   const unpub=await query('UPDATE exams SET score_published=0 WHERE id=? AND score_published=1',[batch.exam_id]);if(unpub.affectedRows)await query("INSERT INTO exam_publish_events(exam_id,action,actor_id,reason) VALUES(?,'unpublish',?,'识别结果回退')",[batch.exam_id,Number(e.ROLLBACK_ACTOR||1)]);
   await query("UPDATE legacy_pdf_jobs SET status='failed',error='已按审计回退自动结果，可重新识别' WHERE batch_id=?",[batch.id]);
   await c.commit();
  }else await c.rollback();
  console.log(JSON.stringify({applied:e.APPLY_ROLLBACK==='1',runId:e.OBJECTIVE_RUN_ID,restored,preserved}));
 }catch(error){await c.rollback();throw error}
 finally{await query('SELECT RELEASE_LOCK(?)',['legacy-batch-'+batch.id]);await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
