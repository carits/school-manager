const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const mysql=require('/app/node_modules/mysql2/promise'),state=JSON.parse(fs.readFileSync('/app/data/answer-card/legacy-pdf/tests/state.json')),dir='/app/data/answer-card/legacy-pdf/tests',base='http://127.0.0.1:5174';let cookie;
async function api(p,m='GET',b,status=200){const headers={Cookie:cookie||''};if(b&&!(b instanceof FormData)){headers['Content-Type']='application/json';b=JSON.stringify(b)}const r=await fetch(base+p,{method:m,headers,body:b});const d=await r.json();assert.equal(r.status,status,p+' '+JSON.stringify(d));if(p==='/api/auth/login')cookie=r.headers.get('set-cookie').split(';')[0];return d}
async function ready(id){for(let i=0;i<150;i++){let d=await api('/api/scan-batches/'+id);if(['ready','marking','finished'].includes(d.batch.status)&&d.papers.every(p=>p.pages.every(x=>!['pending','processing'].includes(x.status))))return d;if(d.batch.status==='failed')throw Error(d.batch.error);await new Promise(r=>setTimeout(r,1000))}throw Error('timeout')}
async function upload(p,t,e){let f=new FormData();f.append('file',new Blob([fs.readFileSync(p)],{type:'application/pdf'}),path.basename(p));f.append('templateId',t);f.append('examId',String(e));return api('/api/scan-batches','POST',f,202)}
async function exam(t,name){let e=await api('/api/templates/'+t+'/exams','POST',{name:'[验收] '+name+' '+Date.now(),classId:state.classId},201);await c.query("UPDATE exam_participants SET source='explicit' WHERE exam_id=? AND student_id IN(?,?)",[e.id,state.users[3].id,state.users[4].id]);return e}
let c;const checks=[];const ok=n=>{checks.push(n);console.log('PASS '+n)};
(async()=>{c=await mysql.createConnection({host:process.env.PROJECTX_MARIADB_HOST,user:process.env.PROJECTX_MARIADB_USER,password:process.env.PROJECTX_MARIADB_PASSWORD,database:process.env.PROJECTX_MARIADB_DATABASE});
await api('/api/auth/login','POST',{identifier:state.users[0].name,password:state.password});
const original=fs.readFileSync('/tmp/test-setup.cjs','utf8').split('(async()=>')[0];
const pdf=new Function('require',original+";return pdf;")(require);
const duplicatePdf=new Function('require',original.replace("['000123','000124']","['000123','000123']")+";return pdf;")(require);
await duplicatePdf(dir+'/duplicate-identity.pdf',state.def,true);const e1=await exam(state.templateId,'重复身份');
const b1=await upload(dir+'/duplicate-identity.pdf',state.templateId,e1.id);await ready(b1.id);
const normal=await api('/api/scan-batches/'+b1.id+'/confirm-normal','POST',{});assert.equal(normal.confirmed,1);assert.equal(normal.skipped.length,1);await api('/api/scan-batches/'+b1.id+'/generate','POST',{},409);ok('duplicate recognized student cannot silently confirm both papers');
let d=await api('/api/scan-batches/'+b1.id);const second=d.papers.find(p=>p.identity_status!=='confirmed');await api('/api/scan-batches/'+b1.id+'/papers/'+second.id+'/confirm','POST',{studentId:state.users[4].id,version:second.version,answers:{q1:['A'],q8:['A']}});await api('/api/scan-batches/'+b1.id+'/generate','POST',{});ok('administrator can resolve duplicate identity with audited binding');
// A4/A3 PDFRotate property is applied before normalized coordinates.
const rotatingPdf=new Function('require',original.replace('doc.addPage();','doc.addPage();doc.page.dictionary.data.Rotate=90;')+";return pdf;")(require);
await rotatingPdf(dir+'/pdfrotate-template.pdf',state.def,false);await rotatingPdf(dir+'/pdfrotate-scan.pdf',state.def,true);
const rotated=structuredClone(state.def);rotated.title='[验收] PDFRotate90';
const rotate=r=>({x:1-r.y-r.height,y:r.x,width:r.height,height:r.width});
for(const p of rotated.pages){p.widthPt=595;p.heightPt=842;for(const a of p.anchorCandidates)a.rect=rotate(a.rect)}
for(const f of rotated.identities){if(f.rect)f.rect=rotate(f.rect);for(const cell of f.cells||[])cell.rect=rotate(cell.rect)}
for(const q of rotated.questions){for(const o of q.options||[])o.rect=rotate(o.rect);for(const r of q.regions||[])r.rect=rotate(r.rect)}
const form=new FormData();form.append('file',new Blob([fs.readFileSync(dir+'/pdfrotate-template.pdf')],{type:'application/pdf'}),'rotate.pdf');form.append('definition',JSON.stringify(rotated));const t=await api('/api/templates','POST',form,201);await api('/api/templates/'+t.id+'/publish','POST',{});
const e2=await exam(t.id,'PDF旋转属性'),b2=await upload(dir+'/pdfrotate-scan.pdf',t.id,e2.id);d=await ready(b2.id);
assert.deepEqual(d.papers.map(p=>p.autoIdentity.studentNumber).sort(),['000123','000124']);assert(d.papers.every(p=>p.pages.every(x=>x.status==='recognized')));ok('PDFRotate90 normalized page coordinates preserve identities and options');
// Misordered roles cannot be accepted until manually repaired.
const first=d.papers[0],last=d.papers[1],back=first.pages[1];await api('/api/scan-batches/'+b2.id+'/pages/'+back.id,'PUT',{paperId:last.id,pageRole:'back'});d=await ready(b2.id);
await api('/api/scan-batches/'+b2.id+'/papers/'+first.id+'/confirm','POST',{studentId:state.users[3].id,version:d.papers[0].version,answers:{q1:['A'],q8:['A']}},409);ok('missing and duplicated page roles block confirmation');
await api('/api/scan-batches/'+b2.id+'/pages/'+back.id,'PUT',{paperId:first.id,pageRole:'back'});await ready(b2.id);let fixed=await api('/api/scan-batches/'+b2.id+'/confirm-normal','POST',{});assert.equal(fixed.confirmed,2);await api('/api/scan-batches/'+b2.id+'/generate','POST',{});ok('manual page ownership repair restores valid task generation');
const e3=await exam(state.templateId,'人工校正'),b3=await upload(dir+'/missing-page.pdf',state.templateId,e3.id);d=await ready(b3.id);
const points=state.def.pages[0].anchorCandidates.map(a=>({x:a.rect.x+a.rect.width/2,y:a.rect.y+a.rect.height/2})),page=d.papers[0].pages[0];
await api('/api/scan-batches/'+b3.id+'/pages/'+page.id,'PUT',{manualPoints:points});d=await ready(b3.id);assert.equal(d.papers[0].pages[0].alignment.manual,true);ok('valid four-point manual correction aligns markerless page');
await api('/api/scan-batches/'+b3.id+'/pages/'+page.id,'PUT',{manualPoints:Array.from({length:4},()=>({x:.5,y:.5}))});d=await ready(b3.id);assert.equal(d.papers[0].pages[0].status,'wait_alignment');ok('degenerate manual correction never guesses grades');
const report=JSON.parse(fs.readFileSync(dir+'/results.json'));report.checks.push(...checks);report.count=report.checks.length;fs.writeFileSync(dir+'/results.json',JSON.stringify(report,null,2));await c.end();console.log('EXTRA '+checks.length+' PASSED');
})().catch(e=>{console.error(e);process.exit(1)});
