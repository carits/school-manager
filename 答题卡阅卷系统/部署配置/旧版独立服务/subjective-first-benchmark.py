import pathlib,subprocess,json,time
WORK=pathlib.Path("/home/ecs-user/school-manager-answer-card-legacy-preview/answer-card")
STATE=pathlib.Path("/home/ecs-user/school-manager-answer-card/answer-card/部署配置/旧版独立服务")
SCRIPT=r"""
import pathlib,json,tempfile,time,subprocess,os
data=json.loads(pathlib.Path('/app/data/answer-card/subjective-first-render-samples.json').read_text())
samples=[p for p in data['pages'] if p['source_page'] in (1,2)]
rows=[]
with tempfile.TemporaryDirectory(prefix='legacy-speed-') as td:
 old=[]
 for n,p in enumerate(samples):
  folder=pathlib.Path(td)/('old'+str(n));folder.mkdir()
  req=json.loads((pathlib.Path(p['raw_path']).parent/(p['pageId']+'.request.json')).read_text())
  t=time.perf_counter()
  subprocess.run(['pdftoppm','-f',str(p['source_page']),'-l',str(p['source_page']),'-singlefile','-r','150','-gray','-png',p['pdf_path'],str(folder/'p')],check=True,capture_output=True)
  req.update(scan=str(folder/'p.png'),aligned=str(folder/'aligned.png'));request=folder/'request.json';request.write_text(json.dumps(req));output=folder/'out.json'
  subprocess.run(['python3','/app/运行资源/legacy-worker.py',str(request),str(output)],check=True,capture_output=True)
  old.append({'ms':round((time.perf_counter()-t)*1000,3),'result':json.loads(output.read_text())})
  print(json.dumps({'baselinePage':n+1,'oldMs':old[-1]['ms']}),flush=True)
 proc=subprocess.Popen(['python3','/candidate.py','--serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'PYTHONUNBUFFERED':'1'})
 counter=0
 def call(req):
  global counter
  counter+=1;proc.stdin.write(json.dumps({'id':counter,'request':req})+'\n');proc.stdin.flush()
  response=json.loads(proc.stdout.readline())
  if response.get('error'):raise RuntimeError(response['error'])
  assert response['id']==counter;return response['result']
 try:
  for n,p in enumerate(samples):
   folder=pathlib.Path(td)/('new'+str(n));folder.mkdir()
   req=json.loads((pathlib.Path(p['raw_path']).parent/(p['pageId']+'.request.json')).read_text())
   began=time.perf_counter();render=call({'action':'render','pdf':p['pdf_path'],'number':p['source_page'],'output':str(folder/'p.png')})
   req.update(scan=render['path'],aligned=str(folder/'aligned.png'),preprocessOnly=True,roster=data['students'])
   preprocess=call(req);preMs=(time.perf_counter()-began)*1000
   objective=[]
   if any(q['gradingType']=='objective' and q.get('pageRole')==p['page_role'] for q in req['template']['questions']):
    req.update(scan=req['aligned'],objectiveOnly=True,preprocessOnly=False);objective=call(req)['questions']
   same=[(q['questionId'],q['value']) for q in old[n]['result']['questions']]==[(q['questionId'],q['value']) for q in objective]
   assert same,'choices changed';assert preprocess['questions']==[]
   row={'subject':'chinese' if p['exam_id']==21 else 'english','role':p['page_role'],'oldFullMs':old[n]['ms'],'newPreprocessMs':round(preMs,3),'newFullMs':round((time.perf_counter()-began)*1000,3),'choicesEqual':same}
   rows.append(row);print(json.dumps(row),flush=True)
 finally:proc.terminate();proc.wait()
print(json.dumps({'report':rows,'cpus':.8,'memoryMiB':1088,'sameSamples':True,'newWorkerProcessCount':1}),flush=True)
"""
def healthy():
 h=json.loads((STATE/"guard/health.json").read_text())
 if h.get("paused") or time.time()*1000-h["time"]>90000:raise RuntimeError("Protected health guard stopped benchmark")
healthy();subprocess.run(["docker","stop","legacy-old-app"],check=True,capture_output=True)
try:
 log=STATE/"subjective-first-benchmark.log"
 with log.open("w") as out:
  proc=subprocess.Popen(["docker","run","--rm","--name","legacy-subjective-benchmark","--init","--network","none","--cpus",".8","--memory","1088m","-e","OPENBLAS_NUM_THREADS=1","-v",str(STATE/"data")+":/app/data/answer-card:ro","-v",str(WORK/"源码/server/services/legacy-pdf-worker.py")+":/candidate.py:ro","--entrypoint","python3","-i","school-manager-legacy:before-subjective-first-20261013"],stdin=subprocess.PIPE,stdout=out,stderr=subprocess.STDOUT,text=True)
  proc.stdin.write(SCRIPT);proc.stdin.close()
  while proc.poll() is None:
   try:healthy()
   except Exception:subprocess.run(["docker","stop","legacy-subjective-benchmark"],check=False,capture_output=True);raise
   time.sleep(3)
  if proc.returncode:raise RuntimeError("Benchmark failed: "+log.read_text()[-1800:])
 lines=[json.loads(l) for l in log.read_text().splitlines() if l.startswith("{")]
 report=next(r for r in lines if "report" in r)
 (WORK/"部署配置/旧版独立服务/subjective-first-benchmark.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps(report),flush=True)
finally:subprocess.run(["docker","start","legacy-old-app"],check=True,capture_output=True)
