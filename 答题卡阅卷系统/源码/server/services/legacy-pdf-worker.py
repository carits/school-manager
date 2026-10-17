import cv2,numpy as np,json,sys,subprocess,tempfile,os,time,hashlib
from collections import OrderedDict
cv2.setNumThreads(1)
REFERENCES=OrderedDict();MASKS=OrderedDict();CURRENT_REFERENCE_HASH=""
def reference_image(file):
 global CURRENT_REFERENCE_HASH
 with open(file,"rb") as f:data=f.read()
 digest=hashlib.sha256(data).hexdigest();CURRENT_REFERENCE_HASH=digest
 if digest not in REFERENCES:
  REFERENCES[digest]=cv2.imdecode(np.frombuffer(data,np.uint8),0)
  if len(REFERENCES)>4:REFERENCES.popitem(last=False)
 REFERENCES.move_to_end(digest);return REFERENCES[digest]
def print_mask(ref,x,y,x1,y1,radius,ay,by,ax,bx):
 key=(CURRENT_REFERENCE_HASH,x,y,x1,y1,radius,ay,by,ax,bx)
 if key not in MASKS:
  MASKS[key]=cv2.dilate((ref[y:y1,x:x1]<200).astype(np.uint8),np.ones((radius*2+1,radius*2+1),np.uint8))[ay:by,ax:bx]==0
  if len(MASKS)>2048:MASKS.popitem(last=False)
 MASKS.move_to_end(key);return MASKS[key]
def render_page(req):
 t=time.perf_counter();out=req["output"];os.makedirs(os.path.dirname(out),exist_ok=True)
 with tempfile.TemporaryDirectory(prefix="legacy-render-") as td:
  subprocess.run(["pdftoppm","-f",str(req["number"]),"-l",str(req["number"]),"-singlefile","-r","150","-gray",req["pdf"],td+"/p"],capture_output=True,check=True,timeout=80)
  image=cv2.imread(td+"/p.pgm",0)
  if image is None:raise ValueError("Unreadable rendered PGM")
  temp=out+".writing.png"
  if not cv2.imwrite(temp,image,[cv2.IMWRITE_PNG_COMPRESSION,1]):raise ValueError("PNG write failed")
  os.replace(temp,out)
 h,w=image.shape;return {"path":out,"width":w,"height":h,"widthPt":w*72/150,"heightPt":h*72/150,"timings":{"renderMs":round((time.perf_counter()-t)*1000,3)}}
def center(a):
 r=a["rect"]
 return a.get("center") or {"x":r["x"]+r["width"]/2,"y":r["y"]+r["height"]/2}
def cut(img,r):
 h,w=img.shape[:2]
 x,y=int(r["x"]*w),int(r["y"]*h)
 return img[y:min(h,int((r["y"]+r["height"])*h)),x:min(w,int((r["x"]+r["width"])*w))]
def darkness(img,r):
 c=cut(img,r)
 if c.size==0:return 0
 h,w=c.shape[:2];c=c[int(h*.22):max(int(h*.78),int(h*.22)+1),int(w*.22):max(int(w*.78),int(w*.22)+1)]
 return float(np.mean(c<140))
def qr_quad(image,rect,padding=.01):
 h,w=image.shape[:2]
 x0=max(0,int((rect["x"]-padding)*w));y0=max(0,int((rect["y"]-padding)*h))
 x1=min(w,int((rect["x"]+rect["width"]+padding)*w));y1=min(h,int((rect["y"]+rect["height"]+padding)*h))
 crop=image[y0:y1,x0:x1]
 if crop.size<64:return None
 detector=cv2.QRCodeDetector();found,points=detector.detect(crop)
 if not found:found,points=detector.detectMulti(crop)
 if not found:return None
 target=np.array([(rect["x"]+rect["width"]/2)*w,(rect["y"]+rect["height"]/2)*h])
 candidates=[p.astype(np.float32)+np.array([x0,y0],np.float32) for p in points]
 return min(candidates,key=lambda p:float(np.linalg.norm(p.mean(axis=0)-target)))

def qr_check(image,ref,locator):
 if not locator:return None
 rect=locator["rect"];expected=qr_quad(ref,rect)
 if expected is None:return {"status":"template_not_detected","revision":locator.get("revision")}
 observed=qr_quad(image,rect,.045)
 if observed is None:return {"status":"not_detected","revision":locator.get("revision")}
 size=float(np.mean(np.linalg.norm(np.roll(expected,-1,axis=0)-expected,axis=1)))
 offset=float(np.linalg.norm(observed.mean(axis=0)-expected.mean(axis=0)))
 # A QR supports the four-corner solution; it cannot replace a missing corner.
 width=float(np.mean(np.linalg.norm(np.roll(observed,-1,axis=0)-observed,axis=1)))
 match=offset<=max(6.,size*.30) and .7<=width/max(size,1.)<=1.3
 return {"status":"verified" if match else "mismatch","offsetPx":round(offset,3),"sizeRatio":round(width/max(size,1.),3),"revision":locator.get("revision"),"algorithm":"qr-auxiliary-v1"}

def align(scan,ref,anchors,manual=None,qr_locator=None):
 h,w=ref.shape[:2];dst=np.float32([[center(a)["x"]*w,center(a)["y"]*h] for a in anchors])
 if len(anchors)!=4: return None,{"status":"wait_alignment","error":"template_requires_four_anchors"}
 if manual:
  if len(manual)!=4:return None,{"status":"wait_alignment","error":"manual_requires_four_points"}
  sh,sw=scan.shape[:2];src=np.float32([[p["x"]*sw,p["y"]*sh] for p in manual])
  if abs(cv2.contourArea(cv2.convexHull(src)))<sw*sh*.15:return None,{"status":"wait_alignment","error":"invalid_anchor_geometry"}
  mat=cv2.getPerspectiveTransform(src,dst)
  warped=cv2.warpPerspective(scan,mat,(w,h),borderValue=255)
  return warped,{"status":"aligned","manual":True,"matrix":mat.tolist(),"confidence":1,"qrLocator":qr_check(warped,ref,qr_locator)}
 best=None
 for rot in range(4):
  image=np.ascontiguousarray(np.rot90(scan,rot));sh,sw=image.shape[:2];image=cv2.resize(image,(w,h))
  src=[];scores=[]
  for a in anchors:
   original=a["rect"]
   x0r=max(0,original["x"]-original["width"]*.5);y0r=max(0,original["y"]-original["height"]*.5)
   r={"x":x0r,"y":y0r,"width":min(1,original["x"]+original["width"]*1.5)-x0r,"height":min(1,original["y"]+original["height"]*1.5)-y0r}
   patch=cut(ref,r)
   x,y=center(a)["x"]*w,center(a)["y"]*h
   x0,y0=max(0,int(x-w*.12)),max(0,int(y-h*.12));x1,y1=min(w,int(x+w*.12)),min(h,int(y+h*.12));area=image[y0:y1,x0:x1]
   top=(-1,None)
   for scale in (.8,1,1.2):
    pw,ph=max(3,int(patch.shape[1]*scale)),max(3,int(patch.shape[0]*scale))
    if ph>=area.shape[0] or pw>=area.shape[1]:continue
    needle=cv2.resize(patch,(pw,ph))
    if float(np.std(needle))<8:continue
    match=cv2.matchTemplate(area,needle,cv2.TM_CCOEFF_NORMED)
    _,val,_,pos=cv2.minMaxLoc(match)
    if val>top[0]:top=(val,[x0+pos[0]+(center(a)["x"]-r["x"])*w*scale,y0+pos[1]+(center(a)["y"]-r["y"])*h*scale])
   scores.append(top[0]);src.append(top[1])
  if min(scores)<.60 or any(x is None for x in src):continue
  points=np.float32(src)
  if abs(cv2.contourArea(cv2.convexHull(points)))<w*h*.15:continue
  # Bound distortion; matching text near a marker must not silently corrupt a page.
  mat=cv2.getPerspectiveTransform(points,dst)
  warped=cv2.warpPerspective(image,mat,(w,h),borderValue=255)
  evidence=qr_check(warped,ref,qr_locator)
  if evidence and evidence["status"]=="mismatch":continue
  quality=float(np.mean(scores))-float(np.mean(np.abs(warped.astype(np.float32)-ref.astype(np.float32))))/255*.5
  if evidence and evidence["status"]=="verified":quality+=.05
  if best is None or quality>best[0]:best=(quality,warped,rot,mat,scores,evidence)
 if best is None:return None,{"status":"wait_alignment","error":"anchors_not_confident"}
 return best[1],{"status":"aligned","confidence":best[0],"rotation":best[2]*90,"matrix":best[3].tolist(),"anchorScores":best[4],"qrLocator":best[5]}

# Calibrated objective OMR; identity recognition deliberately remains unchanged.
ALGORITHM_VERSION="objective-template-residual-v2.0.0"
PARAMETERS={"ink":.22,"coverage":.62,"mean":.24,"distribution":.45,"maskRadius":.12,"localLimit":.20,"coreCoverage":.60,"coreMean":.45,"faintCoreMean":.30,"partialCoverage":.43,"partialMean":.38,"partialDistribution":.30,"erasureMaxMean":.40,"erasureRatio":.50,"erasureStrongMean":.60,"uncertainMargin":.10}
def question_metrics(image,ref,q):
 h,w=image.shape
 boxes=[]
 for o in q.get("options",[]):
  r=o["rect"];x=int(r["x"]*w);y=int(r["y"]*h)
  boxes.append((o,x,y,max(x+1,int((r["x"]+r["width"])*w)),max(y+1,int((r["y"]+r["height"])*h))))
 if not boxes:return []
 left=max(0,min(b[1] for b in boxes)-10);right=min(w,max(b[3] for b in boxes)+10)
 top=max(0,min(b[2] for b in boxes)-10);bottom=min(h,max(b[4] for b in boxes)+10)
 white=max(160.,float(np.percentile(image[top:bottom,left:right],95)))
 # Align only printed outlines/context, never use the filled interiors.
 region=ref[top:bottom,left:right]
 ink=(region<170).astype(np.uint8)
 for option,x,y,x1,y1 in boxes:
  bw,bh=x1-x,y1-y
  filled=darkness(image,option["rect"])>=.5
  insetx=-2 if filled else int(bw*.15);insety=-2 if filled else int(bh*.15)
  ink[max(0,y-top+insety):min(bottom-top,y1-top-insety),
      max(0,x-left+insetx):min(right-left,x1-left-insetx)]=0
 ys,xs=np.nonzero(ink)
 limitx=max(1,int(min(b[3]-b[1] for b in boxes)*.20))
 limity=max(1,int(min(b[4]-b[2] for b in boxes)*.20))
 distance=cv2.distanceTransform((image[top:bottom,left:right]>=white*.72).astype(np.uint8),cv2.DIST_L2,3)
 shift=(0,0);best=float("inf")
 if len(xs)>8:
  xs=xs+left;ys=ys+top
  for dy in range(-limity,limity+1):
   for dx in range(-limitx,limitx+1):
    score=float(np.mean(np.minimum(distance[np.clip(ys+dy-top,0,bottom-top-1),np.clip(xs+dx-left,0,right-left-1)],3)))+.025*(abs(dx)+abs(dy))
    if score<best:best=score;shift=(dx,dy)
 out=[]
 for o,x,y,x1,y1 in boxes:
  bw,bh=x1-x,y1-y
  ax,ay=int(bw*.20),int(bh*.20);bx,by=max(ax+1,int(bw*.80)),max(ay+1,int(bh*.80))
  original=ref[y:y1,x:x1]
  radius=max(1,round(min(bw,bh)*PARAMETERS["maskRadius"]))
  mask=print_mask(ref,x,y,x1,y1,radius,ay,by,ax,bx)
  dx,dy=shift
  scan=image[np.clip(np.arange(y+dy+ay,y+dy+by),0,h-1)[:,None],np.clip(np.arange(x+dx+ax,x+dx+bx),0,w-1)]
  extra=np.clip((white-scan.astype(np.float32))/white,0,1)
  pixels=extra[mask]
  coverage=float(np.mean(pixels>PARAMETERS["ink"])) if pixels.size else 0.
  mean=float(np.mean(pixels)) if pixels.size else 0.
  occupied=[]
  for rows in np.array_split(np.arange(mask.shape[0]),3):
   for cols in np.array_split(np.arange(mask.shape[1]),3):
    m=mask[np.ix_(rows,cols)];v=extra[np.ix_(rows,cols)][m]
    if v.size>=2:occupied.append(float(np.mean(v>PARAMETERS["ink"]))>=.5)
  distribution=float(np.mean(occupied)) if occupied else 0.
  raw=cut(image,o["rect"]);rh,rw=raw.shape
  core=raw[int(rh*.22):max(int(rh*.78),int(rh*.22)+1),int(rw*.22):max(int(rw*.78),int(rw*.22)+1)]
  rawextra=np.clip((white-core.astype(np.float32))/white,0,1)
  corecoverage=float(np.mean(rawextra>.45));coremean=float(np.mean(rawextra))
  decision=max(min(corecoverage/PARAMETERS["coreCoverage"],coremean/PARAMETERS["coreMean"]),min(coverage/PARAMETERS["coverage"],mean/PARAMETERS["mean"],distribution/PARAMETERS["distribution"],coremean/PARAMETERS["faintCoreMean"]),min(coverage/PARAMETERS["partialCoverage"],mean/PARAMETERS["partialMean"],distribution/PARAMETERS["partialDistribution"],corecoverage/PARAMETERS["coreCoverage"]))
  selected=decision>=1.
  out.append({"label":o["label"],"darkness":darkness(image,o["rect"]),"coverage":coverage,"residualMean":mean,"distribution":distribution,"coreCoverage":corecoverage,"coreMean":coremean,"decisionStrength":decision,"selected":bool(selected),"localShift":{"x":dx,"y":dy},"background":white,"validPixels":int(pixels.size)})
 return out
def objective_questions(image,ref,template,role):
 questions=[]
 for q in template["questions"]:
  if q["gradingType"]!="objective" or q.get("pageRole")!=role:continue
  levels=question_metrics(image,ref,q)
  strongest=max([o["residualMean"] for o in levels if o["selected"]],default=0.)
  for o in levels:
   # A weak secondary trace against a strong mark is retained as evidence,
   # but the automatic candidate treats it as an erasure, never silently discards it.
   erased=o["selected"] and strongest>=PARAMETERS["erasureStrongMean"] and o["residualMean"]<PARAMETERS["erasureMaxMean"] and o["residualMean"]<strongest*PARAMETERS["erasureRatio"] and o["coreMean"]<PARAMETERS["coreMean"]
   o["erasureSuspected"]=bool(erased)
   if erased:o["selected"]=False
  value=[o["label"] for o in levels if o["selected"]]
  margins=[o["decisionStrength"]-1. for o in levels]
  uncertain=any(abs(m)<PARAMETERS["uncertainMargin"] for m in margins) or any(o["erasureSuspected"] for o in levels) or any(o["validPixels"]<8 for o in levels)
  status="ambiguous" if uncertain else ("blank" if not value else ("multiple" if len(value)>1 and q.get("selectionType")!="multiple" else "recognized"))
  confidence=max(0.,min(1.,min([abs(m) for m in margins],default=.1)/.35))
  questions.append({"questionId":q["questionId"],"value":value,"status":status,"confidence":confidence,"levels":levels,"algorithmVersion":ALGORITHM_VERSION})
 return questions

def recognize(req):
 started=time.perf_counter();scan=cv2.imread(req["scan"],0);ref=reference_image(req["reference"]);read_done=time.perf_counter()
 if scan is None or ref is None:raise ValueError("Unreadable page image")
 image,alignment=(scan,{"status":"aligned","objectiveOnly":True}) if req.get("objectiveOnly") else align(scan,ref,req["page"].get("anchorCandidates",[]),req.get("manualPoints"),req["page"].get("qrLocator"))
 aligned_done=time.perf_counter()
 if image is None:return {"alignment":alignment,"identities":[],"questions":[],"timings":{"alignmentMs":round((aligned_done-read_done)*1000,3)}}
 if not req.get("objectiveOnly"):cv2.imwrite(req["aligned"],image)
 identities=[];questions=[];role=req["page"]["pageRole"]
 order={"qr":0,"barcode":1,"omr_digits":2,"student_number_ocr":3,"name_ocr":4}
 fields=sorted(req["template"].get("identities",[]),key=lambda f:order.get(f["fieldType"],9))
 roster=req.get("roster",[])
 def matched():
  matches=set()
  for v in identities:
   candidates=[s for s in roster if (str(s["name"])==v["value"] if v["method"]=="name_ocr" else str(s["student_number"])==v["value"])]
   if len(candidates)==1:matches.add(str(candidates[0]["id"]))
  return len(matches)==1
 for f in ([] if req.get("objectiveOnly") or req.get("skipIdentity") else fields):
  if matched():break
  if f["pageRole"]!=role:continue
  kind=f["fieldType"]
  if kind=="omr_digits":
   digits=[];conf=[];detail=[]
   for col in range(1,int(f.get("length",0))+1):
    rows=sorted([(darkness(image,c["rect"]),c["value"]) for c in f.get("cells",[]) if c["column"]==col],reverse=True)
    if len(rows)<2 or rows[0][0]<.35 or rows[0][0]-rows[1][0]<.15:digits.append("?");conf.append(0)
    else:digits.append(str(rows[0][1]));conf.append(min(1,(rows[0][0]-rows[1][0])/.5))
    detail.append(rows)
   if digits and "?" not in digits:identities.append({"method":kind,"value":"".join(digits),"confidence":min(conf),"detail":detail})
  elif f.get("rect"):
   c=cut(image,f["rect"])
   with tempfile.TemporaryDirectory(prefix="legacy-id-") as td:
    p=os.path.join(td,"field.png");cv2.imwrite(p,c)
    if kind in ("qr","barcode"):
     z=subprocess.run(["zbarimg","--quiet",p],capture_output=True,text=True,timeout=10)
     for line in z.stdout.splitlines():
      label,_,val=line.partition(":")
      if val and ((kind=="qr" and label=="QR-Code") or (kind=="barcode" and label!="QR-Code")):identities.append({"method":kind,"value":val.strip(),"confidence":.98})
    else:
     lang="chi_sim+eng" if kind=="name_ocr" else "eng"
     args=["tesseract",p,"stdout","-l",lang,"--psm","7"]
     if kind=="student_number_ocr":args+=["-c","tessedit_char_whitelist=0123456789"]
     z=subprocess.run(args,capture_output=True,text=True,timeout=20)
     val="".join(z.stdout.split())
     if val:identities.append({"method":kind,"value":val,"confidence":.65})
 identity_done=time.perf_counter()
 questions=[] if req.get("preprocessOnly") else objective_questions(image,ref,req["template"],role)
 done=time.perf_counter()
 return {"timings":{"readMs":round((read_done-started)*1000,3),"alignmentMs":round((aligned_done-read_done)*1000,3),"identityMs":round((identity_done-aligned_done)*1000,3),"objectiveMs":round((done-identity_done)*1000,3)},"alignment":alignment,"identities":identities,"questions":questions,"algorithmVersion":ALGORITHM_VERSION,"algorithmParameters":PARAMETERS}
def dispatch(req):
 if req.get("action")=="render":return render_page(req)
 if req.get("detectLocator"):
  points=qr_quad(reference_image(req["reference"]),req["rect"]);return {"points":points.tolist() if points is not None else None}
 return recognize(req)
if __name__=="__main__":
 if len(sys.argv)>1 and sys.argv[1]=="--serve":
  for line in sys.stdin:
   message={}
   try:
    message=json.loads(line);response={"id":message["id"],"result":dispatch(message["request"])}
   except Exception as e:response={"id":message.get("id"),"error":str(e)}
   print(json.dumps(response,ensure_ascii=False),flush=True)
 else:
  try:
   with open(sys.argv[1],encoding="utf-8") as f:req=json.load(f)
   with open(sys.argv[2],"w",encoding="utf-8") as f:json.dump(dispatch(req),f,ensure_ascii=False)
  except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
