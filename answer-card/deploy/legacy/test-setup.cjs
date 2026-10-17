const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const mysql=require('/app/node_modules/mysql2/promise'),bcrypt=require('/app/node_modules/bcryptjs'),PDF=require('/app/node_modules/pdfkit');
const base='http://127.0.0.1:5174',dir='/app/data/answer-card/legacy-pdf/tests';
const statePath=path.join(dir,'state.json');
async function request(url,method='GET',body,cookie){const headers={};if(cookie)headers.Cookie=cookie;if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}const res=await fetch(base+url,{method,headers,body});const raw=await res.text();let data;try{data=JSON.parse(raw)}catch{data=raw}if(!res.ok)throw new Error(url+' '+res.status+' '+JSON.stringify(data));return {res,data};}
async function login(name,password){const {res}=await request('/api/auth/login','POST',{identifier:name,password});const cookie=res.headers.get('set-cookie').split(';')[0];if(!cookie.startsWith('legacy_old_auth_token='))throw Error('Cookie not isolated');return cookie;}
async function pdf(file,def,scans=false){const doc=new PDF({size:[842,595],margin:0,autoFirstPage:false});const sink=fs.createWriteStream(file);doc.pipe(sink);
const rect=(r,fill=false)=>{doc.lineWidth(.4).rect(r.x*842,r.y*595,r.width*842,r.height*595);if(fill)doc.fill('black');else doc.stroke('#777777');};
for(let sheet=0;sheet<(scans?2:1);sheet++)for(let page=0;page<2;page++){doc.addPage();if(scans&&sheet===1&&page===0)doc.rotate(180,{origin:[421,297.5]});const p=def.pages[page];doc.fontSize(16).fillColor('black').text('Custom PDF grading acceptance / '+p.pageRole,110,18);for(const a of p.anchorCandidates)rect(a.rect,true);
if(page===0){const code=scans?['000123','000124'][sheet]:null;for(const c of def.identities[0].cells){rect(c.rect);if(code&&code[c.column-1]===c.value){const r=c.rect;rect({x:r.x+r.width*.20,y:r.y+r.height*.20,width:r.width*.6,height:r.height*.6},true);}}
for(const q of def.questions.filter(q=>q.gradingType==='objective'))for(const o of q.options){rect(o.rect);if(scans&&o.label==='A'){const r=o.rect;rect({x:r.x+r.width*.2,y:r.y+r.height*.2,width:r.width*.6,height:r.height*.6},true);}}}
for(const q of def.questions.filter(q=>q.gradingType==='teacher_score'))for(const a of q.regions.filter(a=>a.pageRole===p.pageRole)){rect(a.rect);doc.fontSize(14).fillColor('black').text(scans?'Written answer / sheet '+(sheet+1):'Question '+q.displayNumber,a.rect.x*842+8,a.rect.y*595+8);}
}
doc.end();await new Promise((resolve,reject)=>{sink.on('finish',resolve);sink.on('error',reject);});}
(async()=>{fs.mkdirSync(dir,{recursive:true});const c=await mysql.createConnection({host:process.env.PROJECTX_MARIADB_HOST,user:process.env.PROJECTX_MARIADB_USER,password:process.env.PROJECTX_MARIADB_PASSWORD,database:process.env.PROJECTX_MARIADB_DATABASE});
const password=crypto.randomBytes(18).toString('hex'),hash=await bcrypt.hash(password,10),users=[];
for(const [name,role,number] of [['__legacy_test_admin',1,null],['__legacy_test_teacher_1',2,null],['__legacy_test_teacher_2',2,null],['__legacy_test_student_1',3,'000123'],['__legacy_test_student_2',3,'000124']]){
let [old]=await c.query('SELECT id FROM users WHERE username=?',[name]);let id=old[0]?.id;if(!id){const [r]=await c.query('INSERT INTO users(username,password_hash,name,role_id,student_number,subject,password_change_required) VALUES(?,?,?,?,?,?,0)',[name,hash,name,role,number,'语文']);id=r.insertId;}else await c.query('UPDATE users SET password_hash=? WHERE id=?',[hash,id]);users.push({id,name,role,number});}
const [classes]=await c.query('SELECT id FROM classes ORDER BY id LIMIT 1');const classId=classes[0].id;
for(const u of users.filter(u=>u.role===3))await c.query('INSERT IGNORE INTO class_students(class_id,student_id) VALUES(?,?)',[classId,u.id]);
const anchors=[{x:.025,y:.025,width:.024,height:.036},{x:.95,y:.025,width:.024,height:.036},{x:.025,y:.94,width:.024,height:.036},{x:.95,y:.94,width:.024,height:.036}].map(rect=>({rect}));
const def={format:'legacy-pdf-template-v1',title:'[验收] A4非连续题号与跨页答案',coordinateSystem:'normalized_top_left',pages:['front','back'].map(pageRole=>({pageRole,widthPt:842,heightPt:595,anchorCandidates:anchors})),identities:[{pageRole:'front',fieldType:'omr_digits',length:6,cells:Array.from({length:60},(_,i)=>({column:Math.floor(i/10)+1,value:String(i%10),rect:{x:.12+Math.floor(i/10)*.05,y:.12+(i%10)*.03,width:.032,height:.018}}))}],questions:[
{questionId:'q1',displayNumber:'1',gradingType:'objective',pageRole:'front',maxScore:2,selectionType:'single',answer:['A'],options:'ABCD'.split('').map((label,i)=>({label,rect:{x:.55+i*.055,y:.25,width:.035,height:.025}})),scoringRule:{type:'exact_match'}},
{questionId:'q8',displayNumber:'8',gradingType:'objective',pageRole:'front',maxScore:4,selectionType:'multiple',answer:['A','B'],options:'ABCD'.split('').map((label,i)=>({label,rect:{x:.55+i*.055,y:.38,width:.035,height:.025}})),scoringRule:{type:'partial',partialScore:1}},
{questionId:'q19',displayNumber:'19',gradingType:'teacher_score',maxScore:5,answer:null,regions:[{pageRole:'front',order:1,rect:{x:.08,y:.65,width:.84,height:.23}},{pageRole:'back',order:2,rect:{x:.08,y:.12,width:.84,height:.76}}]}
],pairing:{suggestedMode:'interleaved_duplex',confirmationRequired:true,preserveSourceOrder:true}};
await pdf(path.join(dir,'template.pdf'),def);await pdf(path.join(dir,'scan.pdf'),def,true);
const cookie=await login(users[0].name,password),form=new FormData();form.append('file',new Blob([fs.readFileSync(path.join(dir,'template.pdf'))],{type:'application/pdf'}),'template.pdf');form.append('definition',JSON.stringify(def));
const {data:t}=await request('/api/templates','POST',form,cookie);await request('/api/templates/'+t.id+'/publish','POST',{},cookie);
const {data:exam}=await request('/api/templates/'+t.id+'/exams','POST',{name:'[验收] PDF完整流程',classId},cookie);
for(const u of users.filter(u=>u.role===3))await c.query("UPDATE exam_participants SET source='explicit' WHERE exam_id=? AND student_id=?",[exam.id,u.id]);
const upload=new FormData();upload.append('file',new Blob([fs.readFileSync(path.join(dir,'scan.pdf'))],{type:'application/pdf'}),'scan.pdf');upload.append('templateId',t.id);upload.append('examId',String(exam.id));
const {data:b}=await request('/api/scan-batches','POST',upload,cookie);
fs.writeFileSync(statePath,JSON.stringify({password,users,classId,templateId:t.id,batchId:b.id,examId:exam.id,def},null,2),{mode:0o600});await c.end();
for(let i=0;i<90;i++){const {data:d}=await request('/api/scan-batches/'+b.id,'GET',undefined,cookie);if(d.batch.status==='failed'||d.batch.status==='paused')throw Error(d.batch.error);if(d.batch.finished>=1){console.log(JSON.stringify({readyForRestart:true,batchId:b.id,finished:d.batch.finished,status:d.batch.status}));return;}await new Promise(r=>setTimeout(r,1000));}throw Error('Recognition did not advance');})().catch(e=>{console.error(e.message);process.exit(1);});
