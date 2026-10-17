const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process');
const state=JSON.parse(fs.readFileSync('/app/data/answer-card/legacy-pdf/tests/state.json'));let cookie;const base='http://127.0.0.1:5174';
async function api(p,m='GET',body,status=200){const headers={Cookie:cookie||''};if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body)}const r=await fetch(base+p,{method:m,headers,body});const d=await r.json();assert.equal(r.status,status,p+' '+JSON.stringify(d));if(p==='/api/auth/login')cookie=r.headers.get('set-cookie').split(';')[0];return d}
(async()=>{await api('/api/auth/login','POST',{identifier:state.users[0].name,password:state.password});
const id='d8032741-c729-4d2d-93d6-97699d44267a',t=await api('/api/templates/'+id);
const code=`import cv2,json
root='/app/data/answer-card/legacy-pdf/templates/d8032741-c729-4d2d-93d6-97699d44267a/'
pages=[]
for n in [1,2]:
 im=cv2.imread(root+'p'+str(n)+'-view-180.png',0);h,w=im.shape
 _,_,stats,_=cv2.connectedComponentsWithStats((im<100).astype('uint8'),8)
 boxes=[{'x':float(x/w),'y':float(y/h),'width':float(bw/w),'height':float(bh/h)} for x,y,bw,bh,area in stats[1:] if bw>10 and bh>10 and .7<bw/bh<1.3 and area/(bw*bh)>.85]
 anchors=[{'rect':min(boxes,key=lambda b:(b['x']+b['width']/2-cx)**2+(b['y']+b['height']/2-cy)**2)} for cx,cy in [(0,0),(1,0),(0,1),(1,1)]]
 pages.append(anchors)
print(json.dumps(pages))`;
const anchors=JSON.parse(cp.execFileSync('python3',['-c',code],{encoding:'utf8'}));t.definition.pages.forEach((p,i)=>p.anchorCandidates=anchors[i]);await api('/api/templates/'+id,'PUT',{definition:t.definition});
const clone=await api('/api/templates/'+id+'/clone','POST',{},201),copy=await api('/api/templates/'+clone.id);copy.definition.title='[验收] 语文真实原稿定位';await api('/api/templates/'+clone.id,'PUT',{definition:copy.definition});await api('/api/templates/'+clone.id+'/publish','POST',{});
const exam=await api('/api/templates/'+clone.id+'/exams','POST',{name:'[验收] 语文真实原稿 '+Date.now(),classId:state.classId},201);
const f=new FormData();f.append('file',new Blob([fs.readFileSync(t.pdf_path)],{type:'application/pdf'}),'Week7-sample.pdf');f.append('templateId',clone.id);f.append('examId',String(exam.id));const batch=await api('/api/scan-batches','POST',f,202);
let data;for(let i=0;i<100;i++){data=await api('/api/scan-batches/'+batch.id);if(data.batch.status==='ready')break;await new Promise(r=>setTimeout(r,1000))}
assert(data.papers[0].pages.every(p=>p.status==='recognized'),'actual school sample alignment');
console.log('REAL_SAMPLE',JSON.stringify({batchId:batch.id,pages:data.papers[0].pages.map(p=>({status:p.status,rotation:p.alignment.rotation})),results:data.papers[0].results.map(r=>({question:r.question_id,auto:r.auto}))}));
await api('/api/scan-batches/'+batch.id+'/generate','POST',{},409);
console.log('PASS real Week7 sample aligns; unconfirmed/missing-key grades remain blocked');
})().catch(e=>{console.error(e);process.exit(1)});
