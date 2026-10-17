#!/usr/bin/env python3
"""One-exam, two-group cutover. Run only against school_manager_legacy on legacy-old-db."""
import gzip,hashlib,json,os,pathlib,sys,time,subprocess
sys.path.insert(0,"/home/ecs-user/review-migration-20261014")
from dbutil import sql
ROOT=pathlib.Path("/home/ecs-user/legacy-review-groups-20261014")
EXAM=22
GROUPS={"english-46-55":list(range(46,56)),"english-56-60":list(range(56,61))}
def rows(query):
 return [line.split("\t") for line in sql(query).splitlines()]
def resources():
 stat=os.statvfs("/")
 disk=stat.f_bavail*stat.f_frsize
 mem=next(int(line.split()[1])*1024 for line in open("/proc/meminfo") if line.startswith("MemAvailable:"))
 if disk<8*1024**3 or mem<800*1024**2:
  raise RuntimeError(f"Stop condition: available bytes disk={disk} memory={mem}")
 return {"diskBytes":disk,"memoryBytes":mem}
def config():
 if not rows("SHOW TABLES LIKE 'legacy_review_groups';"):return []
 return rows("SELECT group_id,questions_json,max_score,mode FROM legacy_review_groups WHERE exam_id=22 ORDER BY group_id;")
def check_config(expected_mode=None):
 got=config()
 if len(got)!=2:raise RuntimeError(f"Expected exactly two group rows; found {len(got)}")
 for name,questions,max_score,mode in got:
  if name not in GROUPS or json.loads(questions)!=GROUPS[name] or float(max_score)!=10:
   raise RuntimeError("Unexpected group config; refusing cutover")
  if expected_mode and mode!=expected_mode:raise RuntimeError(f"{name} is {mode}, expected {expected_mode}")
 return got
def baseline():
 q="""SELECT COUNT(*),COUNT(DISTINCT s.serial_no),SUM(p.identity_status='confirmed' AND p.ownership_confirmed=1)
 FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=b.exam_id WHERE b.exam_id=22;"""
 n,serials,confirmed=map(int,rows(q)[0])
 if (n,serials,confirmed)!=(707,707,707):raise RuntimeError(f"Paper baseline changed: {n}/{serials}/{confirmed}")
 for group,numbers in GROUPS.items():
  title_numbers=','.join("'第%d题'"%n for n in numbers)
  q=f"SELECT block_title,teacher_id,SHA2(COALESCE(assigned_student_ids,''),256) FROM review_assignments a JOIN (SELECT DISTINCT block_id,block_title FROM answer_block_crops WHERE exam_id=22 AND block_title IN ({title_numbers})) b ON b.block_id=a.block_id WHERE a.exam_id=22 ORDER BY block_title,teacher_id;"
  r=rows(q);by_title={}
  for title,teacher,digest in r:by_title.setdefault(title,[]).append((teacher,digest))
  if len(by_title)!=len(numbers) or len({json.dumps(v) for v in by_title.values()})!=1:raise RuntimeError(f"Assignment mismatch: {group}")
  member=rows(f"SELECT COUNT(*),COUNT(DISTINCT source_record_id) FROM answer_block_crops WHERE exam_id=22 AND source_type='legacy_pdf' AND block_title IN ({title_numbers});")[0]
  if tuple(map(int,member))!=(707*len(numbers),707):raise RuntimeError(f"Crop baseline changed: {group} {member}")
 return {"papers":n,"serials":serials,"confirmed":confirmed,"groups":list(GROUPS)}
def fingerprints():
 title_numbers=','.join("'第%d题'"%n for n in range(46,61))
 queries={
  "serials":"SELECT exam_id,serial_no,paper_id FROM legacy_paper_serials WHERE exam_id=22 ORDER BY serial_no;",
  "assignments":f"SELECT a.* FROM review_assignments a JOIN (SELECT DISTINCT block_id FROM answer_block_crops WHERE exam_id=22 AND source_type='legacy_pdf' AND block_title IN ({title_numbers})) x ON x.block_id=a.block_id WHERE a.exam_id=22 ORDER BY a.id;",
  "child_marks":f"SELECT m.*,c.reviewer_id,c.reviewed_at,c.status,c.review_round FROM legacy_pdf_marks m JOIN answer_block_crops c ON c.id=m.crop_id WHERE c.exam_id=22 AND c.source_type='legacy_pdf' AND c.block_title IN ({title_numbers}) ORDER BY m.id;"
 }
 result={}
 for name,query in queries.items():
  data=sql(query).encode("utf-8")
  result[name]={"rows":len(data.splitlines()),"sha256":hashlib.sha256(data).hexdigest()}
 return result
def prepare():
 resources();baseline()
 if config():raise RuntimeError("Groups already configured; inspect before retrying")
 clauses=[]
 for name,numbers in GROUPS.items():
  title="英语第46–55题" if name=="english-46-55" else "英语第56–60题"
  clauses.append(f"(22,'{name}','{title}','{json.dumps(numbers,separators=(',',':'))}',10,'draft')")
 sql("INSERT INTO legacy_review_groups(exam_id,group_id,title,questions_json,max_score,mode) VALUES "+",".join(clauses)+";")
 check_config("draft")
 print(json.dumps({"phase":"draft","baseline":baseline()},ensure_ascii=False))
def freeze():
 resources();baseline();check_config("draft")
 sql("START TRANSACTION; SELECT group_id FROM legacy_review_groups WHERE exam_id=22 FOR UPDATE; UPDATE legacy_review_groups SET mode='transition' WHERE exam_id=22 AND mode='draft'; COMMIT;")
 check_config("transition")
 stamp=ROOT/"freeze-at-switch.json"
 stamp.write_text(json.dumps({"time":time.time(),"baseline":baseline(),"fingerprints":fingerprints()},ensure_ascii=False))
 print(json.dumps({"phase":"transition","stamp":str(stamp)},ensure_ascii=False))
def verify_backup():
 path=ROOT/"backup-at-switch.sql.gz"
 if not path.is_file():raise RuntimeError("Fresh cutover backup missing")
 stamp=json.loads((ROOT/"freeze-at-switch.json").read_text())
 if path.stat().st_mtime<stamp["time"]:raise RuntimeError("Backup predates freeze")
 h=hashlib.sha256()
 with open(path,"rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
 with gzip.open(path,"rb") as f:
  while f.read(1024*1024):pass
 return {"bytes":path.stat().st_size,"sha256":h.hexdigest()}
def historical_score_insert(group,numbers):
 titles=','.join("'第%d题'"%n for n in numbers)
 first='第%d题'%numbers[0]
 count=len(numbers)
 return f"""INSERT INTO legacy_review_group_scores(
  exam_id,serial_no,group_id,paper_id,score,max_score,status,version,graded_by,graded_at,source)
 SELECT 22,ps.serial_no,'{group}',p.id,x.total,10,'reviewed',1,a.teacher_id,x.graded_at,'existing_sum'
 FROM (SELECT m.paper_id,SUM(m.score) total,MAX(c.reviewed_at) graded_at
  FROM legacy_pdf_marks m JOIN answer_block_crops c ON c.id=m.crop_id
  WHERE c.exam_id=22 AND c.source_type='legacy_pdf' AND c.block_title IN ({titles})
  GROUP BY m.paper_id HAVING COUNT(*)={count} AND COUNT(DISTINCT c.block_title)={count}
   AND SUM(m.status='reviewed' AND c.status='reviewed' AND m.score IS NOT NULL)={count}
   AND SUM(m.score) BETWEEN 0 AND 10 AND MOD(SUM(m.score)*2,1)=0) x
 JOIN legacy_pdf_papers p ON p.id=x.paper_id
 JOIN legacy_pdf_batches b ON b.id=p.batch_id AND b.exam_id=22
 JOIN legacy_paper_serials ps ON ps.paper_id=p.id AND ps.exam_id=22
 JOIN answer_block_crops cfirst ON cfirst.source_record_id=p.id AND cfirst.exam_id=22 AND cfirst.block_title='{first}'
 JOIN review_assignments a ON a.exam_id=22 AND a.block_id=cfirst.block_id
  AND JSON_CONTAINS(a.assigned_student_ids,CAST(p.student_id AS CHAR));"""
def activate():
 resources();baseline();check_config("transition")
 backup=verify_backup()
 stamp=json.loads((ROOT/"freeze-at-switch.json").read_text())
 if fingerprints()!=stamp["fingerprints"]:raise RuntimeError("Serial, assignment or child-score baseline changed after freeze")
 # No formal group scores can exist during the frozen transition.
 if int(rows("SELECT COUNT(*) FROM legacy_review_group_scores WHERE exam_id=22;")[0][0]):raise RuntimeError("Unexpected group scores before activation")
 sql("""CREATE TABLE IF NOT EXISTS legacy_review_group_old_claims(
 crop_id VARCHAR(64) PRIMARY KEY,teacher_id INT NOT NULL,claimed_at DATETIME NULL,
 archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );""")
 title_numbers=','.join("'第%d题'"%n for n in range(46,61))
 historical_sql="\n".join(historical_score_insert(group,numbers) for group,numbers in GROUPS.items())
 sql(f"""START TRANSACTION;
 SELECT group_id FROM legacy_review_groups WHERE exam_id=22 FOR UPDATE;
 {historical_sql}
 INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json)
 SELECT 'review_group',CONCAT('22:',g.serial_no,':',g.group_id),'migrate_existing_sum',NULL,NULL,
  JSON_OBJECT('score',g.score,'source','existing_sum','serialNumber',g.serial_no)
 FROM legacy_review_group_scores g WHERE g.exam_id=22 AND g.source='existing_sum';
 INSERT IGNORE INTO legacy_review_group_old_claims(crop_id,teacher_id,claimed_at)
 SELECT id,claimed_by,claimed_at FROM answer_block_crops WHERE exam_id=22 AND source_type='legacy_pdf'
 AND block_title IN ({title_numbers}) AND claimed_by IS NOT NULL;
 UPDATE answer_block_crops SET claimed_by=NULL,claimed_at=NULL WHERE exam_id=22 AND source_type='legacy_pdf'
 AND block_title IN ({title_numbers}) AND claimed_by IS NOT NULL;
 UPDATE legacy_review_groups SET mode='active' WHERE exam_id=22 AND mode='transition';
 COMMIT;""")
 check_config("active")
 initialized=rows("SELECT group_id,COUNT(*),COALESCE(SUM(score),0) FROM legacy_review_group_scores WHERE exam_id=22 AND source='existing_sum' GROUP BY group_id ORDER BY group_id;")
 print(json.dumps({"phase":"active","backup":backup,"initializedHistoricalScores":initialized,"oldClaimsArchived":int(rows("SELECT COUNT(*) FROM legacy_review_group_old_claims;")[0][0])},ensure_ascii=False))
if __name__=="__main__":
 phase=sys.argv[1] if len(sys.argv)==2 else ""
 if phase=="preflight":print(json.dumps({"resources":resources(),"baseline":baseline(),"config":config()},ensure_ascii=False))
 elif phase=="prepare":prepare()
 elif phase=="freeze":freeze()
 elif phase=="activate":activate()
 else:raise SystemExit("Usage: review_group_cutover.py preflight|prepare|freeze|activate")
