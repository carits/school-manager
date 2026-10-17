import {getMysqlDb,type DbAdapter} from "../db";

type Row=Record<string,any>;
export const serialSchema=[
`CREATE TABLE IF NOT EXISTS legacy_exam_serials (
 exam_id INT NOT NULL,identity_key VARCHAR(100) NOT NULL,serial_no INT NOT NULL,
 source VARCHAR(24) NOT NULL DEFAULT 'local',reference_task_id VARCHAR(64) NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(exam_id,identity_key),UNIQUE KEY exam_serial_number(exam_id,serial_no)
)`,
`CREATE TABLE IF NOT EXISTS legacy_paper_serials (
 paper_id VARCHAR(64) NOT NULL,exam_id INT NOT NULL,serial_no INT NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(paper_id),UNIQUE KEY exam_paper_serial(exam_id,serial_no)
)`,
`CREATE TABLE IF NOT EXISTS legacy_exam_serial_counters (
 exam_id INT PRIMARY KEY,next_no INT NOT NULL
)`
];
export async function ensurePaperSerialSchema(db:DbAdapter=getMysqlDb()){
 for(const sql of serialSchema)await db.exec(sql);
}
// Must run inside a transaction. The exam row is the shared lock used by upload,
// identity confirmation, exam rebinding, and startup backfill.
export async function assignPaperSerial(db:DbAdapter,examId:number,paperId:string,operator:number|null=null):Promise<number>{
 const exam=await db.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",examId);
 if(!exam)throw new Error("流水号所属考试不存在");
 const p=await db.get<Row>("SELECT p.student_id FROM legacy_pdf_papers p WHERE p.id=?",paperId);
 if(!p)throw new Error("流水号所属试卷不存在");
 // Keeping a paper number must not bypass the old cross-batch duplicate-student
 // protection previously enforced indirectly by the identity-based serial key.
 if(p.student_id!=null){
  const duplicate=await db.get<Row>("SELECT p.id FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id WHERE b.exam_id=? AND p.student_id=? AND p.id<>? LIMIT 1",examId,p.student_id,paperId);
  if(duplicate)throw Object.assign(new Error("该考试已有同一学生的其他答卷，请先处理重复卷；原流水号与成绩保留"),{status:409});
 }
 // A serial belongs to the paper, not its mutable student identity. Preserve
 // every existing same-exam number, including historical review mappings.
 const old=await db.get<Row>("SELECT exam_id,serial_no FROM legacy_paper_serials WHERE paper_id=?",paperId);
 if(old&&Number(old.exam_id)===examId){
  const n=Number(old.serial_no);
  if(!Number.isSafeInteger(n)||n<=0)throw Object.assign(new Error("原流水号无效，请管理员核对；不会自动重编号"),{status:409});
  return n;
 }
 let key="p:"+paperId;
 let serial=await db.get<Row>("SELECT serial_no FROM legacy_exam_serials WHERE exam_id=? AND identity_key=?",examId,key);
 if(!serial&&p.student_id!=null){
  const historicalKey="u:"+p.student_id;
  const historical=await db.get<Row>("SELECT serial_no FROM legacy_exam_serials WHERE exam_id=? AND identity_key=?",examId,historicalKey);
  if(historical){key=historicalKey;serial=historical;}
 }
 if(!serial){
  await db.run("INSERT IGNORE INTO legacy_exam_serial_counters(exam_id,next_no) SELECT ?,COALESCE(MAX(serial_no),0)+1 FROM (SELECT serial_no FROM legacy_exam_serials WHERE exam_id=? UNION ALL SELECT serial_no FROM legacy_paper_serials WHERE exam_id=?) existing_numbers",examId,examId,examId);
  const counter=await db.get<Row>("SELECT next_no FROM legacy_exam_serial_counters WHERE exam_id=? FOR UPDATE",examId);
  const max=await db.get<Row>("SELECT COALESCE(MAX(serial_no),0) n FROM (SELECT serial_no FROM legacy_exam_serials WHERE exam_id=? UNION ALL SELECT serial_no FROM legacy_paper_serials WHERE exam_id=?) existing_numbers",examId,examId);
  const n=Math.max(Number(counter!.next_no),Number(max!.n)+1);
  await db.run("INSERT INTO legacy_exam_serials(exam_id,identity_key,serial_no) VALUES(?,?,?)",examId,key,n);
  await db.run("UPDATE legacy_exam_serial_counters SET next_no=? WHERE exam_id=?",n+1,examId);
  serial={serial_no:n};
 }
 const n=Number(serial.serial_no);
 const other=await db.get<Row>("SELECT paper_id FROM legacy_paper_serials WHERE exam_id=? AND serial_no=? AND paper_id<>? LIMIT 1",examId,n,paperId);
 if(other)throw Object.assign(new Error("该考试的流水号已属于另一份试卷，请先处理重复卷；成绩不会覆盖"),{status:409});
 if(!old||Number(old.exam_id)!==examId||Number(old.serial_no)!==n){
  await db.run("INSERT INTO legacy_paper_serials(paper_id,exam_id,serial_no) VALUES(?,?,?) ON DUPLICATE KEY UPDATE exam_id=VALUES(exam_id),serial_no=VALUES(serial_no)",paperId,examId,n);
  await db.run("INSERT INTO legacy_pdf_audit(entity_type,entity_id,action,operator_id,before_json,after_json) VALUES(?,?,?,?,?,?)",
   "paper",paperId,"assign_exam_serial",operator,old?JSON.stringify(old):null,JSON.stringify({examId,serialNumber:n,identityKey:key}));
 }
 return n;
}
// Upload and duplicate-upload recovery allocate only missing numbers, in source
// sheet order, before the batch transaction becomes visible to the client.
export async function assignBatchPaperSerials(db:DbAdapter,examId:number,batchId:string,operator:number|null=null){
 await db.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",examId);
 const papers=await db.all<Row>("SELECT p.id FROM legacy_pdf_papers p LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=? WHERE p.batch_id=? AND s.paper_id IS NULL ORDER BY p.sheet_no,p.id",examId,batchId);
 for(const p of papers)await assignPaperSerial(db,examId,p.id,operator);
}
export async function backfillPaperSerials(db:DbAdapter=getMysqlDb()){
 const exams=await db.all<Row>("SELECT DISTINCT exam_id FROM legacy_pdf_batches ORDER BY exam_id");
 for(const e of exams)await db.transaction(async tx=>{
  await tx.get<Row>("SELECT id FROM exams WHERE id=? FOR UPDATE",e.exam_id);
  const papers=await tx.all<Row>("SELECT p.id FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id LEFT JOIN legacy_paper_serials ps ON ps.paper_id=p.id AND ps.exam_id=b.exam_id WHERE b.exam_id=? AND ps.paper_id IS NULL ORDER BY b.created_at,b.id,p.sheet_no,p.id",e.exam_id);
  for(const p of papers)await assignPaperSerial(tx,Number(e.exam_id),p.id);
 });
}
