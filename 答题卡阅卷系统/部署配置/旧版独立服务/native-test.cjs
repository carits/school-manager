const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:5174',state=JSON.parse(fs.readFileSync('/app/data/answer-card/legacy-pdf/tests/state.json'));
let cookie;
async function api(p,m='GET',b){const h={Cookie:cookie||''};if(b&&!(b instanceof FormData)){h['Content-Type']='application/json';b=JSON.stringify(b)}const r=await fetch(base+p,{method:m,headers:h,body:b});const bytes=Buffer.from(await r.arrayBuffer());let d;try{d=JSON.parse(bytes.toString())}catch{d=bytes}if(!r.ok)throw Error(p+' '+r.status+' '+JSON.stringify(d));if(p==='/api/auth/login')cookie=r.headers.get('set-cookie').split(';')[0];return d}
(async()=>{await api('/api/auth/login','POST',{identifier:state.users[0].name,password:state.password});
const card=await api('/api/cards','POST',{title:'[验收] A4原设计卡兼容 '+Date.now(),subject:'yuwen',paperSize:'A4'});
card.bodyBlocks=[{id:'native-objective-'+card.id,type:'objective',title:'客观题',questionStart:1,questionCount:2,optionCount:4,mode:'single',scorePerQuestion:2,density:'comfortable',questions:[{questionNumber:1,mode:'single',optionCount:4,score:2,answerKey:['A']},{questionNumber:8,mode:'multiple',optionCount:4,score:4,answerKey:['A','B','C'],scoringRule:{type:'per_selected_count',partialScores:{1:1,2:2},wrongOrExtraScore:0}}]},{id:'native-subjective-'+card.id,type:'subjective',blockKind:'answer',title:'主观题',questions:[{id:'native-q19-'+card.id,number:19,score:5,style:'plain_subjective',kind:'plain_box',minHeightMm:90}]}];
card.studentInfo={...card.studentInfo,studentNumberDigits:6,showStudentNumber:true};await api('/api/cards/'+card.id,'PUT',card);
const exam=await api('/api/exams','POST',{name:'[验收] A4原卡兼容 '+Date.now(),cardId:card.id,classId:state.classId,subject:'数学'});
const bytes=await api('/api/cards/'+card.id+'/pdf');assert(bytes.toString('ascii',0,5)==='%PDF-');
const f=new FormData();f.append('file',new Blob([bytes],{type:'application/pdf'}),'native-a4.pdf');f.append('examId',String(exam.id));
const accepted=await api('/api/cards/'+card.id+'/submissions/pdf','POST',f);assert(accepted.jobId);
for(let i=0;i<90;i++){const d=await api('/api/grading/jobs/'+accepted.jobId);if(d.status==='done'){assert(d.requiresConfirmation);break}if(d.status==='error')throw Error(d.error);if(i===89)throw Error('timeout');await new Promise(r=>setTimeout(r,1000))}
const details=await api('/api/scan-batches/'+accepted.jobId);assert.equal(details.batch.template_id.length,36);assert(details.papers.length);
const template=await api('/api/templates/'+details.batch.template_id);assert.equal(template.status,'published');assert(template.definition.pages.every(p=>p.anchorCandidates.length===4));
assert.equal(template.definition.questions.find(q=>q.questionId==='q8').scoringRule.type,'legacy_rule');
await api('/api/scan-batches/'+accepted.jobId+'/papers/'+details.papers[0].id+'/confirm','POST',{studentId:state.users[3].id,version:details.papers[0].version,answers:{q1:['A'],q8:['A']}});
const confirmed=await api('/api/scan-batches/'+accepted.jobId);assert.equal(Number(confirmed.papers[0].results.find(r=>r.question_id==='q8').score),1);
await api('/api/scan-batches/'+accepted.jobId+'/generate','POST',{});
assert.equal((await api('/api/scan-batches/'+accepted.jobId+'/marks')).marks.length,1);
console.log('PASS ordinary configured A4 native design PDF, frozen rules, persistent adapter and task generation');
const outcome=JSON.parse(fs.readFileSync('/app/data/answer-card/legacy-pdf/tests/results.json'));outcome.checks.push('ordinary A4 native card persistent PDF adapter');outcome.count=outcome.checks.length;fs.writeFileSync('/app/data/answer-card/legacy-pdf/tests/results.json',JSON.stringify(outcome,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
