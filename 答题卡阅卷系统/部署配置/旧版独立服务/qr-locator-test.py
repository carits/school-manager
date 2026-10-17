import cv2,json,pathlib,importlib.util,numpy as np
spec=importlib.util.spec_from_file_location('omr','/app/运行资源/legacy-worker.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);cv2.setNumThreads(1)
root=pathlib.Path('/app/data/answer-card');inp=json.loads((root/'chinese-replacement-input.json').read_text());st=json.loads((root/'chinese-replacement-staged.json').read_text())
ref=cv2.imread(inp['pages'][0]['path'],0);rect={"x":.034,"y":.066,"width":.038,"height":.052};locator={"rect":rect,"revision":1}
assert m.qr_quad(ref,rect) is not None
counts={}
for p in st['pages']:
 if not p['recognition']['questions']:continue
 im=cv2.imread(p['aligned_path'],0);e=m.qr_check(im,ref,locator);counts[e['status']]=counts.get(e['status'],0)+1
 assert e['status']!='mismatch',str(e)
# No QR must not replace a corner or force a transform.
missing=ref.copy();h,w=ref.shape;x,y=int(rect['x']*w),int(rect['y']*h);missing[y-10:int((rect['y']+rect['height'])*h)+10,x-10:int((rect['x']+rect['width'])*w)+10]=255
assert m.qr_check(missing,ref,locator)['status']=='not_detected'
assert m.qr_check(ref,ref,locator)['status']=='verified'
shifted=ref.copy();patch=missing[y-10:int((rect['y']+rect['height'])*h)+10,x-10:int((rect['x']+rect['width'])*w)+10]
# A 35 px displaced QR falls inside search but disagrees with corner geometry.
H=np.float32([[1,0,35],[0,1,0]]);offset=cv2.warpAffine(ref,H,(w,h),borderValue=255)
assert m.qr_check(offset,ref,locator)['status']=='mismatch'
image,a=m.align(missing,ref,inp['definition']['pages'][0]['anchorCandidates'],qr_locator=locator);assert image is not None and a['qrLocator']['status']=='not_detected'
blank=np.full_like(ref,255);image,a=m.align(blank,ref,inp['definition']['pages'][0]['anchorCandidates'],qr_locator=locator);assert image is None
first=next(p for p in st['pages'] if p['recognition']['questions']);sample=cv2.imread(first['aligned_path'],0);expected=[q['value'] for q in first['recognition']['questions']]
for rotation in [0,90,180,270]:
 aligned,evidence=m.align(np.ascontiguousarray(np.rot90(sample,rotation//90)),ref,inp['definition']['pages'][0]['anchorCandidates'],qr_locator=locator)
 assert aligned is not None and evidence['qrLocator']['status']=='verified'
 assert [q['value'] for q in m.objective_questions(aligned,ref,inp['definition'],'front')]==expected
report={"realChineseFrontPages":43,"qrStatusCounts":counts,"missingQrFallsBackToFourCorners":True,"qrMismatchDetected":True,"missingAllAnchorsRequiresManualCorrection":True,"templateQrRegion":rect,"fourRotationsPreserveAnswers":True}
(root/'qr-locator-acceptance.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
