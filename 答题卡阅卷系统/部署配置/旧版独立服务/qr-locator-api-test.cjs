const fs=require('fs'),assert=require('assert/strict'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{const e=process.env,c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});assert.equal(e.PROJECTX_MARIADB_HOST,'legacy-old-db');assert.equal(e.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');
const query=async(s,a=[])=>{const[r]=await c.execute(s,a);return r};let cookie;
const req=async(path,method='GET',body)=>{let r=await fetch('http://127.0.0.1:5174/api'+path,{method,headers:{Cookie:cookie||'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});let data=await r.json();return{status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]}};
try{
const login=await req('/auth/login','POST',{identifier:'admin',password:e.TEST_ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.cookie;
const tid='efb6bbfc-8036-45d1-a1be-00c68bb659cf',prefix='/templates/'+tid,bid='3d2fd1ae-39d4-41b1-992b-d09aae6242aa';
const before=(await req(prefix)).data,batchBefore=(await req('/scan-batches/'+bid)).data;
const cardsBefore=await query('SELECT id,revision,title FROM answer_cards ORDER BY id'),catalogBefore=await query('SELECT id,revision,definition_json FROM legacy_pdf_templates ORDER BY id');
assert.equal(before.definition.questions.length,19);assert.equal(before.definition.questions.reduce((n,q)=>n+q.maxScore,0),120);assert.equal(batchBefore.papers.length,43);assert.equal(batchBefore.papers.flatMap(p=>p.results).length,430);assert.equal(batchBefore.batch.template_id,tid);
const rect={x:.034,y:.066,width:.038,height:.052};
const saved=await req(prefix+'/qr-locator','PUT',{pageRole:'front',rect,expectedRevision:0});assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.revision,1);
const again=await req(prefix+'/qr-locator','PUT',{pageRole:'front',rect,expectedRevision:1});assert.equal(again.status,200);assert.equal(again.data.unchanged,true);
assert.equal((await req(prefix+'/qr-locator','PUT',{pageRole:'front',rect,expectedRevision:0})).status,409);
assert.equal((await req(prefix+'/qr-locator','PUT',{pageRole:'front',rect:{x:-1,y:0,width:.1,height:.1},expectedRevision:1})).status,400);
assert.equal((await req(prefix+'/qr-locator','PUT',{pageRole:'back',rect,expectedRevision:0})).status,400);
const after=(await req(prefix)).data,batchAfter=(await req('/scan-batches/'+bid)).data;assert.deepEqual(after.definition,before.definition);assert.deepEqual(after.locators[0].rect,rect);
assert.deepEqual(batchAfter.papers,batchBefore.papers);assert.deepEqual(await query('SELECT id,revision,title FROM answer_cards ORDER BY id'),cardsBefore);assert.deepEqual(await query('SELECT id,revision,definition_json FROM legacy_pdf_templates ORDER BY id'),catalogBefore);
assert.equal((await query('SELECT count(*) n FROM legacy_pdf_qr_locators WHERE template_id=?',['0c50a3a3-ce7c-48fc-a01c-ceb9c0cfac96']))[0].n,0);
const english=await query("SELECT count(*) n,sum(JSON_LENGTH(final_value)>1) multis FROM legacy_pdf_results r JOIN legacy_pdf_papers p ON p.id=r.paper_id WHERE p.batch_id='ac549507-ebdd-4924-b982-29968c2eb1d2'");assert.equal(english[0].n,2385);assert.equal(Number(english[0].multis),0);
const q8=await query('SELECT answers_json FROM legacy_pdf_exam_keys WHERE exam_id=21');assert.deepEqual(JSON.parse(q8[0].answers_json).q8,['B','E']);
let tmp=cookie;cookie=undefined;assert.equal((await req(prefix+'/qr-locator','PUT',{pageRole:'front',rect,expectedRevision:1})).status,401);cookie=tmp;
const report={chineseQuestions:19,totalScore:120,papers:43,objectiveResults:430,qrConfigured:true,settingsSaveIdempotent:true,staleRevision409:true,invalidRegion400:true,noQrRejected400:true,unauthenticated401:true,existingDefinitionsAndCardCountsUnchanged:true,existingResultsAndOwnershipUnchanged:true,englishQrSettingsAbsent:true,englishObjectiveMultiAnswers:0};
fs.writeFileSync('/app/data/answer-card/qr-locator-api-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{if(cookie)await req('/auth/logout','POST',{});await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
