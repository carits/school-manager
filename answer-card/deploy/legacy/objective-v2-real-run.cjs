const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{
 const e=process.env;assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 const query=async(s,a=[])=>{const [r]=await c.execute(s,a);return r};
 let cookie;const request=async(p,body,method='POST')=>{const r=await fetch('http://127.0.0.1:5174/api'+p,{method,headers:{Cookie:cookie||'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify({status:r.status,message:data.message}));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 try{
  cookie=(await request('/auth/login',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD})).cookie;
  const bid='ac549507-ebdd-4924-b982-29968c2eb1d2',p='/scan-batches/'+bid,before=(await request(p,undefined,'GET')).data;
  assert.equal(before.batch.pdf_hash,'711eea4aa7454bb2134cf19db3dff5ec364bae3075c80fbebb00c4a1c455a13f');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(before.batch.pdf_path)).digest('hex');assert.equal(hash,before.batch.pdf_hash);
  const catalog=await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id');
  const marks=await query('SELECT m.* FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? ORDER BY m.id',[bid]);
  fs.writeFileSync('/app/data/answer-card/objective-v2-real-before.json',JSON.stringify({before,catalog,marks}),{mode:0o600});
  const queued=(await request(p+'/reprocess-objective',{})).data;console.log(JSON.stringify({runId:queued.runId,status:queued.status,reused:queued.reused}));
  let after;
  for(let i=0;i<180;i++){
   after=(await request(p,undefined,'GET')).data;
   if(after.objectiveRun?.status==='done')break;
   if(after.objectiveRun?.status==='failed')throw Error(after.objectiveRun.error);
   await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(after.objectiveRun?.status,'done','real batch timed out');
  const identities=x=>x.papers.map(p=>[p.id,p.student_id,p.identity_status,p.ownership_confirmed,p.auto_identity,p.pages.map(pg=>[pg.id,pg.paper_id,pg.page_role,pg.aligned_path,pg.alignment_json,pg.version])]);
  assert.deepEqual(identities(after),identities(before));
  assert.deepEqual(await query('SELECT id,revision,definition_json,pdf_hash,card_id FROM legacy_pdf_templates ORDER BY id'),catalog);
  assert.deepEqual(await query('SELECT m.* FROM legacy_pdf_marks m JOIN legacy_pdf_papers p ON p.id=m.paper_id WHERE p.batch_id=? ORDER BY m.id',[bid]),marks);
  let preserved=0;for(const paper of before.papers)for(const r of paper.results)if(r.final_source!=='auto'){
   const current=after.papers.find(p=>p.id===paper.id).results.find(q=>q.id===r.id);assert.equal(current.final_value,r.final_value);assert.equal(current.score,r.score);preserved++;
  }
  const finalHash=crypto.createHash('sha256').update(fs.readFileSync(after.batch.pdf_path)).digest('hex');assert.equal(finalHash,hash);
  const report={...after.objectiveRun,papers:after.papers.length,results:after.papers.reduce((n,p)=>n+p.results.length,0),sourceHash:finalHash,sourceUnchanged:true,identitiesAndOwnershipUnchanged:true,templatesUnchanged:true,teacherMarksUnchanged:true,protectedFinalsVerified:preserved,oldAutoMultiple:before.papers.flatMap(p=>p.results).filter(r=>r.auto?.value?.length>1).length,newAutoMultiple:after.papers.flatMap(p=>p.results).filter(r=>r.auto?.value?.length>1).length,missingKeyScores:after.papers.flatMap(p=>p.results).filter(r=>r.score==null).length};
  fs.writeFileSync('/app/data/answer-card/objective-v2-real-after.json',JSON.stringify(after),{mode:0o600});
  fs.writeFileSync('/app/data/answer-card/objective-v2-real-report.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{if(cookie)await request('/auth/logout',{}).catch(()=>{});await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
