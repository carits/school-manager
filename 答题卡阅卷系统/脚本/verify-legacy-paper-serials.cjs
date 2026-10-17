// Isolated SQL regressions. Never connect to the application database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const ts=require(process.env.SERIAL_TEST_TYPESCRIPT || '/home/ecs-user/school-manager-answer-card/answer-card/node_modules/typescript');
const source=fs.readFileSync(path.join(root,'源码/server/services/LegacyPaperSerialService.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
const mod={exports:{}};
vm.runInNewContext(compiled.outputText,{module:mod,exports:mod.exports,console,
 require:n=>n==='../db'?{getMysqlDb:()=>{throw Error('Production database forbidden in this test');}}:(()=>{throw Error('Unexpected import '+n);})()});
const service=mod.exports;
let db,log,queue;
const normalize=sql=>sql.replace(/ FOR UPDATE/g,'').replace(/INSERT IGNORE/g,'INSERT OR IGNORE')
 .replace(/ON DUPLICATE KEY UPDATE exam_id=VALUES\(exam_id\),serial_no=VALUES\(serial_no\)/g,'ON CONFLICT(paper_id) DO UPDATE SET exam_id=excluded.exam_id,serial_no=excluded.serial_no');
const adapter={
 async get(sql,...p){log.push({kind:'get',sql});return db.prepare(normalize(sql)).get(...p)||null;},
 async all(sql,...p){log.push({kind:'all',sql});return db.prepare(normalize(sql)).all(...p);},
 async run(sql,...p){log.push({kind:'run',sql});const r=db.prepare(normalize(sql)).run(...p);return {changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)};},
 async exec(){throw Error('Tests initialize their own schema');},
 transaction(fn){const current=queue.catch(()=>{}).then(async()=>{db.exec('BEGIN');try{const result=await fn(adapter);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}});queue=current;return current;},
 transactionWithNamedLock(name,wait,fn){return adapter.transaction(fn);}
};
function setup(){
 db?.close();db=new DatabaseSync(':memory:');log=[];queue=Promise.resolve();
 db.exec(`CREATE TABLE exams(id INT PRIMARY KEY,card_id TEXT);
 CREATE TABLE legacy_pdf_batches(id TEXT PRIMARY KEY,exam_id INT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,template_id TEXT,pdf_hash TEXT,pdf_path TEXT,original_name TEXT,total INT,created_by INT,status TEXT DEFAULT 'queued');
 CREATE TABLE legacy_pdf_papers(id TEXT PRIMARY KEY,batch_id TEXT,sheet_no INT,student_id INT);
 CREATE TABLE legacy_exam_serials(exam_id INT,identity_key TEXT,serial_no INT,PRIMARY KEY(exam_id,identity_key),UNIQUE(exam_id,serial_no));
 CREATE TABLE legacy_paper_serials(paper_id TEXT PRIMARY KEY,exam_id INT,serial_no INT,UNIQUE(exam_id,serial_no));
 CREATE TABLE legacy_exam_serial_counters(exam_id INT PRIMARY KEY,next_no INT);
 CREATE TABLE legacy_pdf_audit(entity_type TEXT,entity_id TEXT,action TEXT,operator_id INT,before_json TEXT,after_json TEXT);
 CREATE TABLE legacy_serial_question_scores(exam_id INT,serial_no INT,paper_id TEXT,score REAL);
 INSERT INTO exams(id,card_id) VALUES(21,'card'),(22,'card'),(45,'card');
 INSERT INTO legacy_pdf_batches(id,exam_id,created_at) VALUES('first',45,'2026-10-14 10:00:00'),('second',45,'2026-10-14 11:00:00'),('history',22,'2026-10-01 00:00:00');`);
}
const rows=sql=>db.prepare(sql).all().map(x=>({...x}));
const mapping=()=>rows('SELECT * FROM legacy_paper_serials ORDER BY exam_id,serial_no');
const add=(id,batch,sheet,student=null)=>db.prepare('INSERT INTO legacy_pdf_papers VALUES(?,?,?,?)').run(id,batch,sheet,student);
const writes=()=>log.filter(x=>x.kind==='run');
function uploadFixture(){
 db.exec(`CREATE TABLE legacy_pdf_pages(id TEXT PRIMARY KEY,batch_id TEXT,paper_id TEXT,source_page INT,page_role TEXT,raw_path TEXT);
 CREATE TABLE legacy_pdf_jobs(batch_id TEXT PRIMARY KEY);
 CREATE TABLE legacy_pdf_batch_locators(batch_id TEXT PRIMARY KEY,settings_json TEXT);`);
 const text=fs.readFileSync(path.join(root,'源码/server/services/LegacyPdfService.ts'),'utf8');
 const tree=ts.createSourceFile('LegacyPdfService.ts',text,ts.ScriptTarget.Latest,true);
 const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='createLegacyBatch');
 assert.ok(fn,'Upload function exists');
 const output=ts.transpileModule(fn.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};let uuid=0,preprocess=0;
 vm.runInNewContext(output,{module:m,exports:m.exports,manage:()=>{},
  template:async()=>({id:'template',status:'published',card_id:'card'}),getVisibleExamIds:async()=>null,
  storePdf:async()=>({hash:'same-hash',path:'/test/immutable.pdf'}),pdfInfo:async()=>4,
  definition:()=>({pages:[{pageRole:'page1'},{pageRole:'page2'}],questions:[]}),
  db:()=>adapter,uid:()=>`uuid-${++uuid}`,actor:()=>1,root:'/test',path,
  createHash:require('node:crypto').createHash,qrLocators:async()=>[],audit:async()=>{},
  assignBatchPaperSerials:service.assignBatchPaperSerials,
  queuePreprocess:async()=>{
   assert.equal(rows("SELECT COUNT(*) n FROM legacy_paper_serials WHERE exam_id=45")[0].n,2,'All paper numbers exist before recognition is queued');
   preprocess++;
  },err:(status,message)=>Object.assign(Error(message),{status})});
 return {upload:m.exports.createLegacyBatch,queued:()=>preprocess};
}
async function main(){
 setup();add('z-first','first',1);add('a-second','first',2);add('m-third','first',3);
 await adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,'first',1));
 assert.deepEqual(mapping().map(x=>[x.paper_id,x.serial_no]),[['z-first',1],['a-second',2],['m-third',3]]);
 const original=mapping();log=[];
 await adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,'first',1));
 assert.deepEqual(mapping(),original);assert.equal(writes().length,0);
 for(const student of [800,801,null]){
  db.prepare('UPDATE legacy_pdf_papers SET student_id=? WHERE id=?').run(student,'z-first');log=[];
  assert.equal(await adapter.transaction(tx=>service.assignPaperSerial(tx,45,'z-first',1)),1);
  assert.deepEqual(mapping(),original);assert.equal(writes().length,0);
 }
 assert.equal(db.prepare('SELECT next_no FROM legacy_exam_serial_counters WHERE exam_id=45').get().next_no,4);
 console.log('PASS upload page order, immediate numbering, duplicate upload and changed student preserve numbers');

 setup();add('old','history',1,77);
 db.exec("INSERT INTO legacy_paper_serials VALUES('old',22,704); INSERT INTO legacy_exam_serials VALUES(22,'u:77',5); INSERT INTO legacy_serial_question_scores VALUES(22,704,'old',13);");
 const before=mapping();log=[];
 assert.equal(await adapter.transaction(tx=>service.assignPaperSerial(tx,22,'old')),704);
 await service.backfillPaperSerials(adapter);
 assert.deepEqual(mapping(),before);assert.equal(writes().length,0);
 assert.equal(rows('SELECT score FROM legacy_serial_question_scores')[0].score,13);
 console.log('PASS historical number and score survive mismatched identity registry and startup backfill');

 setup();add('imported','history',1,88);db.exec("INSERT INTO legacy_exam_serials VALUES(22,'u:88',701)");
 assert.equal(await adapter.transaction(tx=>service.assignPaperSerial(tx,22,'imported')),701);
 add('old-high','history',2);db.exec("INSERT INTO legacy_paper_serials VALUES('old-high',22,999); INSERT INTO legacy_exam_serial_counters VALUES(22,2)");
 add('new','history',3);
 assert.equal(await adapter.transaction(tx=>service.assignPaperSerial(tx,22,'new')),1000);
 assert.equal(rows('SELECT next_no FROM legacy_exam_serial_counters WHERE exam_id=22')[0].next_no,1001);
 console.log('PASS existing historical registry reused, and stale counters advance past every reserved old number');

 setup();add('z-first','first',1);add('a-second','first',2);
 await adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,'first'));
 const preserved=mapping();db.exec("UPDATE legacy_pdf_papers SET student_id=55 WHERE id='a-second'; DELETE FROM legacy_paper_serials WHERE paper_id='a-second'");
 db.exec("INSERT INTO legacy_exam_serials VALUES(45,'u:55',99)");
 await service.backfillPaperSerials(adapter);assert.deepEqual(mapping(),preserved);
 log=[];await service.backfillPaperSerials(adapter);assert.equal(writes().length,0);
 console.log('PASS missing historical mapping restored from paper old number even after identity change, repeated backfill does not write');

 setup();add('original','first',1);add('duplicate','second',1);
 await adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,'first'));
 await adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,'second'));
 db.exec("UPDATE legacy_pdf_papers SET student_id=99 WHERE id='original'");
 const stable=mapping();
 await assert.rejects(adapter.transaction(async tx=>{
  await tx.run("UPDATE legacy_pdf_papers SET student_id=99 WHERE id='duplicate'");
  return service.assignPaperSerial(tx,45,'duplicate');
 }),e=>e.status===409);
 assert.equal(rows("SELECT student_id FROM legacy_pdf_papers WHERE id='duplicate'")[0].student_id,null);
 assert.deepEqual(mapping(),stable);
 console.log('PASS cross-batch duplicate student rejected with transaction rollback and original numbers intact');

 setup();add('one','first',1);add('two','second',1);
 await Promise.all(['first','second','first'].map(b=>adapter.transaction(tx=>service.assignBatchPaperSerials(tx,45,b))));
 assert.equal(mapping().length,2);assert.equal(new Set(mapping().map(x=>x.serial_no)).size,2);
 console.log('PASS concurrent/retried batch requests serialize allocation without duplicate numbers');

 setup();const fixture=uploadFixture();
 const upload=()=>fixture.upload({user:{id:1}},{path:'/test/upload.pdf',originalname:'math.pdf'},'template',45);
 const uploaded=await Promise.all([upload(),upload()]);
 assert.equal(uploaded[0].id,uploaded[1].id);assert.equal(uploaded[0].reused,false);assert.equal(uploaded[1].reused,true);
 assert.equal(fixture.queued(),4);assert.equal(mapping().length,2);
 const pages=rows('SELECT source_page,page_role,paper_id FROM legacy_pdf_pages ORDER BY source_page');
 assert.equal(pages[0].paper_id,pages[1].paper_id);assert.equal(pages[2].paper_id,pages[3].paper_id);
 assert.notEqual(pages[0].paper_id,pages[2].paper_id);
 const current=mapping();
 db.prepare('DELETE FROM legacy_paper_serials WHERE paper_id=?').run(current[1].paper_id);
 const retried=await upload();assert.equal(retried.reused,true);assert.deepEqual(mapping(),current);
 assert.equal(fixture.queued(),4);assert.equal(rows('SELECT COUNT(*) n FROM legacy_pdf_pages')[0].n,4);
 console.log('PASS real upload transaction creates numbered two-page papers before recognition, deduplicates racing uploads and repairs missing numbers');
 db.close();console.log('ALL PAPER SERIAL REGRESSIONS PASSED');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
