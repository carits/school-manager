"""Stop only the legacy service and preserve new marks, answers and scores."""
import pathlib,subprocess,importlib.util,json,sys
WORK=pathlib.Path("/home/ecs-user/school-manager-answer-card-legacy-preview/answer-card")
STATE=pathlib.Path("/home/ecs-user/school-manager-answer-card/answer-card/deploy/legacy")
BACKUP="school-manager-legacy:before-subjective-first-20261013"
def run(args,**kw):return subprocess.run(args,check=True,stdout=subprocess.PIPE,text=True,**kw).stdout
def check():
 cfg=dict(x.split("=",1) for x in (STATE/"legacy.env").read_text().splitlines() if "=" in x)
 if cfg.get("PROJECTX_MARIADB_HOST")!="legacy-old-db" or cfg.get("PROJECTX_MARIADB_DATABASE")!="school_manager_legacy":raise RuntimeError("Refusing protected database")
 app=json.loads(run(["docker","inspect","legacy-old-app"]))[0]
 if any(m.get("Name","").startswith("answer-card_") for m in app["Mounts"]):raise RuntimeError("Refusing protected volume")
 run(["docker","image","inspect",BACKUP])
check()
if "--check" in sys.argv:
 print("Legacy-only rollback target and retained image verified");sys.exit(0)
run(["docker","stop","legacy-old-app"])
adapter=r"""
const mysql=require('/app/node_modules/mysql2/promise');
(async()=>{
 const e=process.env;if(e.PROJECTX_MARIADB_HOST!=='legacy-old-db'||e.PROJECTX_MARIADB_DATABASE!=='school_manager_legacy')throw Error('wrong database');
 const c=await mysql.createConnection({host:e.PROJECTX_MARIADB_HOST,user:e.PROJECTX_MARIADB_USER,password:e.PROJECTX_MARIADB_PASSWORD,database:e.PROJECTX_MARIADB_DATABASE});
 await c.beginTransaction();
 const [batches]=await c.query("SELECT DISTINCT batch_id FROM legacy_pdf_stage_jobs WHERE status IN('queued','running')");
 await c.query("UPDATE legacy_pdf_pages p JOIN legacy_pdf_stage_jobs j ON j.page_id=p.id SET p.status='pending' WHERE j.kind='preprocess' AND j.status='running' AND p.status='processing'");
 await c.query("UPDATE legacy_pdf_stage_jobs SET status='queued',lease_until=NULL WHERE status='running'");
 for(const b of batches){
  await c.execute("UPDATE legacy_pdf_batches SET objective_paused=1 WHERE id=?",[b.batch_id]);
  await c.execute("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,after_json) VALUES('batch',?,'pipeline_rollback',?)",[b.batch_id,JSON.stringify({stageTasksRetained:true,teacherScoresRetained:true,paused:true})]);
 }
 await c.query("UPDATE legacy_pdf_jobs SET status='done',lease_until=NULL WHERE kind='scan' AND status='staged'");
 await c.commit();await c.end();console.log(JSON.stringify({pausedBatches:batches.length,restoredDatabaseSnapshot:false}));
})().catch(e=>{console.error(e.message);process.exit(1)});
"""
current=json.loads(run(["docker","inspect","legacy-old-app"]))[0]["Image"]
try:
 print(run(["docker","run","--rm","--init","--network","legacy-old","--cpus",".8","--memory","1088m","--env-file",str(STATE/"legacy.env"),"-v",str(STATE/"data")+":/app/data/answer-card","--entrypoint","node","-i",current],input=adapter).strip())
 spec=importlib.util.spec_from_file_location("legacy_runtime",WORK/"deploy/legacy/runtime.py");mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);mod.start(BACKUP)
except Exception:
 run(["docker","start","legacy-old-app"]);raise
print("Rolled back legacy service only. Stage tasks remain saved; forward recovery can resume them. No database snapshot was restored.")
