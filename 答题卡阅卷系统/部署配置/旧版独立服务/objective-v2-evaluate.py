import cv2,json,numpy as np,importlib.util,collections,os,time
spec=importlib.util.spec_from_file_location('worker','/tmp/omr-v2.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
b=json.load(open('/tmp/english-recognition-investigation.json'));t=json.load(open('/tmp/english-recognition-template.json'))
defs=t['definition'];refs={p['pageRole']:cv2.imread(json.loads(t['pages_json'])[i]['path'],0) for i,p in enumerate(defs['pages'])}
results=[];os.makedirs('/tmp/omr-v2',exist_ok=True)
for p in b['papers']:
 images={x['page_role']:cv2.imread(x['aligned_path'],0) for x in p['pages']}
 qs=[q for q in defs['questions'] if q['gradingType']=='objective']
 tile=np.full((9*60+28,5*180,3),255,np.uint8)
 cv2.putText(tile,'Sheet '+str(p['sheet_no'])+' - visually label Q1..Q45; no predictions',(5,18),cv2.FONT_HERSHEY_SIMPLEX,.45,(0,0,0),1)
 for k,q in enumerate(qs):
  im=images[q['pageRole']];h,w=im.shape;opts=q['options']
  x=(k%5)*180;y=(k//5)*60+28
  cv2.putText(tile,'Q'+q['displayNumber'],(x+3,y+12),cv2.FONT_HERSHEY_SIMPLEX,.38,(0,0,0),1)
  for j,o in enumerate(opts):
   rect=o['rect'];left=int(rect['x']*w);top=int(rect['y']*h);right=int((rect['x']+rect['width'])*w);bottom=int((rect['y']+rect['height'])*h)
   crop=cv2.cvtColor(im[top:bottom,left:right],cv2.COLOR_GRAY2BGR);crop=cv2.resize(crop,(29,30),interpolation=cv2.INTER_CUBIC)
   tile[y+19:y+49,x+5+j*34:x+34+j*34]=crop
   cv2.putText(tile,o['label'],(x+7+j*34,y+17),cv2.FONT_HERSHEY_SIMPLEX,.28,(0,0,0),1)
  rec=m.objective_questions(im,refs[q['pageRole']],{'questions':[q]},q['pageRole'])[0]
  old=next(x for x in p['results'] if x['question_id']==q['questionId'])
  results.append({'sheet':p['sheet_no'],'question':q['questionId'],'new':rec,'old':old['auto']})
 cv2.imwrite('/tmp/omr-v2/sheet-'+str(p['sheet_no'])+'.jpg',tile,[cv2.IMWRITE_JPEG_QUALITY,90])
json.dump(results,open('/tmp/omr-v2/features.json','w'))
print('evaluated',len(results),'statuses',dict(collections.Counter(x['new']['status'] for x in results)))
print('blank',[(x['sheet'],x['question']) for x in results if not x['new']['value']])
print('multi',[(x['sheet'],x['question'],x['new']['value']) for x in results if len(x['new']['value'])>1])
print('hard',[(x['sheet'],x['question'],x['new']['value'],[(o['label'],round(o['coverage'],3),round(o['residualMean'],3),round(o['distribution'],3)) for o in x['new']['levels']]) for x in results if (x['sheet'],x['question']) in [(23,'q37'),(28,'q10'),(32,'q40'),(47,'q10'),(47,'q45'),(47,'q5'),(47,'q7'),(47,'q9')]])
