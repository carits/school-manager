const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),path=require('node:path');
const mysql=require('/app/node_modules/mysql2/promise'),sharp=require('/app/node_modules/sharp'),XLSX=require('/app/node_modules/xlsx'),PDF=require('/app/node_modules/pdfkit');
const dir='/app/data/answer-card/legacy-pdf/tests',state=JSON.parse(fs.readFileSync(dir+'/state.json')),base='http://127.0.0.1:5174';
const checks=[];
function ok(name,condition=true){assert.ok(condition,name);checks.push(name);console.log('PASS '+name);}
async function req(p,method='GET',body,cookie,expected=200){const headers={};if(cookie)headers.Cookie=cookie;if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}const r=await fetch(base+p,{method,headers,body});const bytes=Buffer.from(await r.arrayBuffer());let data;try{data=JSON.parse(bytes.toString())}catch{data=bytes}if(r.status!==expected)throw Error(p+' expected '+expected+' got '+r.status+' '+(Buffer.isBuffer(data)?data.toString().slice(0,200):JSON.stringify(data)));return {r,data,bytes};}
async function login(u){const {r}=await req('/api/auth/login','POST',{identifier:u.name,password:state.password});return r.headers.get('set-cookie').split(';')[0];}
async function ready(id,cookie){for(let i=0;i<120;i++){const {data:d}=await req('/api/scan-batches/'+id,'GET',undefined,cookie);if(['ready','marking','finished'].includes(d.batch.status)&&d.papers.every(p=>p.pages.every(x=>!['pending','processing'].includes(x.status))))return d;if(d.batch.status==='failed')throw Error(d.batch.error);await new Promise(r=>setTimeout(r,1000));}throw Error('Recognition timeout');}
async function upload(file,t,e,cookie){const f=new FormData();f.append('file',new Blob([fs.readFileSync(file)],{type:'application/pdf'}),path.basename(file));f.append('templateId',t);f.append('examId',String(e));return (await req('/api/scan-batches','POST',f,cookie,202)).data;}
(async()=>{
const c=await mysql.createConnection({host:process.env.PROJECTX_MARIADB_HOST,user:process.env.PROJECTX_MARIADB_USER,password:process.env.PROJECTX_MARIADB_PASSWORD,database:process.env.PROJECTX_MARIADB_DATABASE});
const admin=await login(state.users[0]),teacher1=await login(state.users[1]),teacher2=await login(state.users[2]),bid=state.batchId,p='/api/scan-batches/'+bid;
let d=await ready(bid,admin);
ok('restart recovery completed all four pages',d.batch.finished===4&&d.papers.length===2);
ok('six-digit leading zeros preserved',d.papers.map(p=>p.autoIdentity.studentNumber).sort().join(',')==='000123,000124');
ok('rotated page aligned',d.papers[1].pages[0].alignment.rotation===180);
ok('non-contiguous objective IDs retained',d.papers.every(p=>p.results.map(r=>r.question_id).sort().join(',')==='q1,q8'));
await req(p+'/generate','POST',{},admin,409);ok('task generation requires human confirmation');
await req(p+'/summary.xlsx','GET',undefined,admin,409);ok('unfinished final export blocked');
await req('/api/templates/'+state.templateId,'PUT',{definition:state.def},admin,409);ok('published template immutable');
const dup=await upload(dir+'/scan.pdf',state.templateId,state.examId,admin);ok('duplicate PDF reuses original batch',dup.reused&&dup.id===bid);
await req('/api/templates','GET',undefined,teacher1,403);ok('teacher cannot edit or list template answer keys');
await req(p+'/confirm-normal','POST',{},admin);
d=(await req(p,'GET',undefined,admin)).data;
ok('manual batch confirmation separates auto and final results',d.papers.every(p=>p.identity_status==='confirmed'&&p.results.every(r=>r.status==='confirmed'&&r.final.length===1)));
ok('explicit multi-select partial score',d.papers.every(p=>Number(p.results.find(r=>r.question_id==='q8').score)===1));
await req(p+'/generate','POST',{},admin);
let marks=(await req(p+'/marks','GET',undefined,admin)).data.marks;ok('administrator explicitly generates two subjective tasks',marks.length===2);
await req(p+'/generate','POST',{},admin);ok('task generation idempotent',(await req(p+'/marks','GET',undefined,admin)).data.marks.length===2);
const image=await req(marks[0].imageUrl,'GET',undefined,admin);const meta=await sharp(image.bytes).metadata();ok('cross-page crop generated on demand',meta.width>1000&&meta.height>1000);
await req('/api/review-assign/exams/'+state.examId+'/blocks/'+marks[0].block_id,'POST',{teacherCounts:{[state.users[1].id]:1,[state.users[2].id]:1}},admin);
const m1=(await req(p+'/marks','GET',undefined,teacher1)).data.marks,m2=(await req(p+'/marks','GET',undefined,teacher2)).data.marks;ok('reused legacy per-student assignment is disjoint',m1.length===1&&m2.length===1&&m1[0].id!==m2[0].id);
await req(p+'/marks/'+m1[0].id+'/image','GET',undefined,teacher2,403);ok('teacher cannot view another assigned paper');
const attempts=await Promise.all([req(p+'/marks/'+m1[0].id+'/claim','POST',{},teacher1),req(p+'/marks/'+m1[0].id+'/claim','POST',{},teacher2,403)]);ok('concurrent claim respects allocation');
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:6,version:0},teacher1,422);ok('out-of-range scores rejected');
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:4,version:0},teacher1);
const repeated=await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:4,version:0},teacher1);ok('duplicate score submission idempotent',repeated.data.reused);
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:3,version:0},teacher1,409);ok('stale correction version rejected');
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:3,version:1},teacher1);
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:4,version:2},teacher1);
await req(p+'/marks/'+m2[0].id+'/claim','POST',{},teacher2);await req(p+'/marks/'+m2[0].id+'/score','PUT',{score:4,version:0},teacher2);
const {data:s}=await req(p+'/summary','GET',undefined,admin);ok('final totals derive confirmed and scored values',s.students.every(s=>s.complete&&s.total===7));
const x=await req(p+'/summary.xlsx','GET',undefined,admin);const book=XLSX.read(x.bytes,{type:'buffer'}),rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);ok('Excel preserves leading-zero student numbers',rows.map(r=>r['学号']).sort().join(',')==='000123,000124');
const {data:a}=await req(p+'/audit','GET',undefined,admin);const revision=a.events.find(e=>e.action==='rescore'&&JSON.parse(e.before_json).score===4&&JSON.parse(e.after_json).score===3);ok('score and before-after audit committed together',!!revision);
await req('/api/exams/'+state.examId+'/publish','POST',{},admin);ok('complete finalized exam may publish');
const {data:published}=await req(p,'GET',undefined,admin);
const page=published.papers[0].pages[0],before=published.papers[0].results.find(r=>r.question_id==='q1');
const [pageRows]=await c.query('SELECT * FROM legacy_pdf_pages WHERE id=?',[page.id]);const raw=pageRows[0].raw_path;const png=await sharp(raw).metadata();
const q1=state.def.questions[0].options[0].rect;const overlay=Buffer.from('<svg width="'+Math.ceil(q1.width*png.width)+'" height="'+Math.ceil(q1.height*png.height)+'"><rect width="100%" height="100%" fill="white"/></svg>');
const originalBytes=fs.readFileSync(raw);const replacement=await sharp(originalBytes).composite([{input:overlay,left:Math.floor(q1.x*png.width),top:Math.floor(q1.y*png.height)}]).png().toBuffer();fs.writeFileSync(raw,replacement);
await c.query("UPDATE legacy_pdf_pages SET status='pending' WHERE id=?",[page.id]);await req(p+'/retry','POST',{},admin);const retried=await ready(bid,admin);const after=retried.papers[0].results.find(r=>r.question_id==='q1');
ok('re-recognition preserves manually confirmed final result',after.auto.status==='blank'&&after.final.join('')==='A'&&after.status==='confirmed'&&Number(after.score)===2);
fs.writeFileSync(raw,originalBytes);
const [orig]=await c.query('SELECT pdf_path,pdf_hash FROM legacy_pdf_batches WHERE id=?',[bid]);ok('original PDF retained with unchanged digest',crypto.createHash('sha256').update(fs.readFileSync(orig[0].pdf_path)).digest('hex')===orig[0].pdf_hash);
const changed=await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:3,version:3},teacher1);const [pub]=await c.query('SELECT score_published FROM exams WHERE id=?',[state.examId]);ok('correction automatically withdraws published scores',pub[0].score_published===0);
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:4,version:4},teacher1);
// Missing answer keys must not produce marks, even after human identity confirmation.
const {data:cloned}=await req('/api/templates/'+state.templateId+'/clone','POST',{},admin,201);const def=structuredClone(state.def);def.title='[验收] 缺标准答案';def.questions[1].answer=null;
await req('/api/templates/'+cloned.id,'PUT',{definition:def},admin);await req('/api/templates/'+cloned.id+'/publish','POST',{},admin);
const {data:exam2}=await req('/api/templates/'+cloned.id+'/exams','POST',{name:'[验收] 缺标准答案',classId:state.classId},admin,201);
for(const u of state.users.filter(u=>u.role===3))await c.query("UPDATE exam_participants SET source='explicit' WHERE exam_id=? AND student_id=?",[exam2.id,u.id]);
const b2=await upload(dir+'/scan.pdf',cloned.id,exam2.id,admin);await ready(b2.id,admin);await req('/api/scan-batches/'+b2.id+'/confirm-normal','POST',{},admin);await req('/api/scan-batches/'+b2.id+'/generate','POST',{},admin,409);ok('missing standard answer blocks task generation');
await req('/api/scan-batches/'+b2.id+'/answer-key','PUT',{answers:{q8:['A','B']}},admin);await req('/api/scan-batches/'+b2.id+'/generate','POST',{},admin);ok('audited answer-key supplement enables generation');
await req('/api/exams/'+exam2.id+'/publish','POST',{},admin,409);ok('unscored placeholder rows cannot publish');
// A missing page or markers stays an exception; no guessing.
const bad=dir+'/missing-page.pdf';const doc=new PDF({size:[842,595],margin:0});const sink=fs.createWriteStream(bad);doc.pipe(sink);doc.fontSize(20).text('No layout markers',100,100);doc.end();await new Promise(r=>sink.on('finish',r));
const {data:exam3}=await req('/api/templates/'+state.templateId+'/exams','POST',{name:'[验收] 缺页与定位异常',classId:state.classId},admin,201);const b3=await upload(bad,state.templateId,exam3.id,admin);const badData=await ready(b3.id,admin);
ok('missing markers require manual alignment',badData.papers[0].pages[0].status==='wait_alignment');
await req('/api/scan-batches/'+b3.id+'/papers/'+badData.papers[0].id+'/confirm','POST',{studentId:state.users[3].id,version:badData.papers[0].version,answers:{q1:['A'],q8:['A']}},admin,409);ok('missing page blocks confirmation');
await req(p+'/marks/'+m1[0].id+'/score','PUT',{score:4,version:0},teacher1);ok('same-score retry remains safe after corrections');
await req('/api/auth/logout','POST',{},admin);await req('/api/auth/me','GET',undefined,admin,401);ok('old isolated logout revokes only its own session');
await c.end();fs.writeFileSync(dir+'/results.json',JSON.stringify({checks,count:checks.length,state:{batchId:bid,templateId:state.templateId,examId:state.examId},time:new Date().toISOString()},null,2));console.log('TOTAL '+checks.length+' CHECKS PASSED');
})().catch(e=>{console.error(e.stack);process.exit(1);});
