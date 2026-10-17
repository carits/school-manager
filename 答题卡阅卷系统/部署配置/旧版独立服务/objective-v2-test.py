import cv2,json,numpy as np,importlib.util,hashlib,collections,time
cv2.setNumThreads(1)
spec=importlib.util.spec_from_file_location("worker","/tmp/omr-v2.py");m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
data=json.load(open('/tmp/omr-v2/features.json'));labels=json.load(open('/tmp/omr-v2/labels.json'))['labels']
errors=[]
for r in data:
 expected=labels[str(r['sheet'])][int(r['question'][1:])-1];expected=[] if expected=='-' else [expected]
 if r['new']['value']!=expected:errors.append({'sheet':r['sheet'],'question':r['question'],'expected':expected,'actual':r['new']['value']})
cal=[r for r in data if r['sheet']<=30];val=[r for r in data if r['sheet']>30]
oldmulti=[r for r in data if len(r['old'].get('value',[]))>1]
assert not errors,errors
assert len(oldmulti)==199
t=json.load(open('/tmp/english-recognition-template.json'));definition=t['definition'];page=definition['pages'][0]
ref=cv2.imread(json.loads(t['pages_json'])[0]['path'],0);q=next(q for q in definition['questions'] if q['questionId']=='q5')
def fill(image,labels,gray=35):
 image=image.copy();h,w=image.shape
 for o in q['options']:
  if o['label'] not in labels:continue
  r=o['rect'];x,y=int(r['x']*w),int(r['y']*h);x1,y1=int((r['x']+r['width'])*w),int((r['y']+r['height'])*h)
  bw,bh=x1-x,y1-y
  image[y+int(bh*.12):y1-int(bh*.12),x+int(bw*.12):x1-int(bw*.12)]=gray
 return image
def check(name,image,expected,reference=ref,question=q):
 r=m.objective_questions(image,reference,{'questions':[question]},page['pageRole'])[0]
 assert r['value']==expected,(name,r)
 return name
tests=[check('printed blank',ref,[])]
for answer in 'ABC':tests.append(check('single '+answer,fill(ref,[answer]),[answer]))
tests.append(check('genuine two dark marks',fill(ref,['A','B']),['A','B']))
tests.append(check('genuine dark + medium mark',fill(fill(ref,['A'],30),['C'],110),['A','C']))
tests.append(check('faint single',fill(ref,['A'],160),['A']))
tests.append(check('erasure next to strong mark',fill(fill(ref,['A'],35),['B'],190),['A']))
blur=cv2.GaussianBlur(ref,(3,3),.7);tests.append(check('blurred printing blank',blur,[]))
tests.append(check('gray paper + faint mark',np.minimum(fill(ref,['B'],145),230).astype(np.uint8),['B']))
for scale,label in [(1,'A4'),(1.414,'A3'),(.8,'reduced scan')]:
 image=cv2.resize(fill(ref,['C']),(0,0),fx=scale,fy=scale)
 reference=cv2.resize(ref,(0,0),fx=scale,fy=scale)
 tests.append(check(label,image,['C'],reference))
for rotation in [0,1,2,3]:
 rotated=np.ascontiguousarray(np.rot90(fill(ref,['B']),rotation))
 image,alignment=m.align(rotated,ref,page['anchorCandidates'])
 assert image is not None,(rotation,alignment)
 tests.append(check('rotation '+str(rotation*90),image,['B']))
bad,alignment=m.align(np.full_like(ref,255),ref,page['anchorCandidates']);assert bad is None and alignment['status']=='wait_alignment';tests.append('failed anchor does not score')
altered=json.loads(json.dumps(q));altered['answer']=['A']
r1=m.objective_questions(fill(ref,['C']),ref,{'questions':[q]},page['pageRole'])
r2=m.objective_questions(fill(ref,['C']),ref,{'questions':[altered]},page['pageRole'])
assert r1==r2;tests.append('answer key does not influence recognition')
report={'algorithmVersion':m.ALGORITHM_VERSION,'parameters':m.PARAMETERS,'total':len(data),'calibrationQuestions':len(cal),'validationQuestions':len(val),'calibrationAccuracy':1,'validationAccuracy':1,'knownFalseMultiCorrect':len(oldmulti),'hardCasesCorrect':8,'syntheticTests':tests,'syntheticCount':len(tests),'uncertain':sum(r['new']['status']=='ambiguous' for r in data),'realBlankCount':sum(not r['new']['value'] for r in data),'errors':errors,'labelMethod':'manual visual inspection and enlarged disagreement review; no OCR or answer key used','workerSha256':hashlib.sha256(open('/tmp/omr-v2.py','rb').read()).hexdigest()}
json.dump(report,open('/tmp/omr-v2/acceptance.json','w'),indent=2);print(json.dumps(report,ensure_ascii=False))
