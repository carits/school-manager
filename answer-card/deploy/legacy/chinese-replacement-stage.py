import pathlib,json,cv2,importlib.util,hashlib,time
root=pathlib.Path('/app/data/answer-card')
spec=importlib.util.spec_from_file_location('omr','/app/resources/legacy-worker.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);cv2.setNumThreads(1)
snapshot=json.loads((root/'chinese-replacement-before.json').read_text());input=json.loads((root/'chinese-replacement-input.json').read_text());definition=input['definition']
refs={p['pageRole']:cv2.imread(input['pages'][i]['path'],0) for i,p in enumerate(definition['pages'])}
directory=root/'legacy-pdf/replacements'/input['id'];directory.mkdir(parents=True,exist_ok=True)
out=[];failed=[]
for page in snapshot['pages']:
 guard=pathlib.Path('/app/guard/health.json')
 # Resource and protected-service checks use the runtime-mounted guard file.
 import os
 guard=pathlib.Path(os.environ['LEGACY_PROTECTED_HEALTH_FILE'])
 health=json.loads(guard.read_text())
 if health['paused'] or time.time()*1000-health['time']>90000:raise RuntimeError('health guard paused/stale')
 mem=int(pathlib.Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
 stat=os.statvfs(root)
 if mem<800*1024**2 or stat.f_bavail*stat.f_frsize<8*1024**3:raise RuntimeError('resource guard')
 scan=cv2.imread(page['raw_path'],0);pg=next(x for x in definition['pages'] if x['pageRole']==page['page_role']);ref=refs[page['page_role']]
 manual=json.loads(page['manual_json']) if page.get('manual_json') else None
 if isinstance(manual,dict):manual=manual.get('points')
 image,alignment=m.align(scan,ref,pg['anchorCandidates'],manual)
 rec=json.loads(page['recognition_json'] or '{}');rec['alignment']=alignment
 if image is None:
  failed.append({'page':page['source_page'],'error':alignment});continue
 path=directory/(page['id']+'.png');cv2.imwrite(str(path),image)
 rec['questions']=m.objective_questions(image,ref,definition,page['page_role'])
 rec['algorithmVersion']=m.ALGORITHM_VERSION;rec['algorithmParameters']=m.PARAMETERS
 out.append({'id':page['id'],'version':page['version'],'rawHash':hashlib.sha256(pathlib.Path(page['raw_path']).read_bytes()).hexdigest(),'aligned_path':str(path),'alignment':alignment,'recognition':rec})
 if len(out)%10==0:print(json.dumps({'finished':len(out),'failed':len(failed)}),flush=True)
(root/'chinese-replacement-staged.json').write_text(json.dumps({'pages':out,'failed':failed,'algorithmVersion':m.ALGORITHM_VERSION}))
print(json.dumps({'finished':len(out),'failed':failed,'objectiveResults':sum(len(p['recognition']['questions']) for p in out),'minAnchorScore':min(min(p['alignment'].get('anchorScores',[1])) for p in out)}),flush=True)
