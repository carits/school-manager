import {getMysqlDb,type DbAdapter} from "../db";
import {normalizePdfTemplate,type PdfTemplate} from "../../shared/legacyPdf";
type Row=Record<string,any>;
export const serialScoreSchema=`CREATE TABLE IF NOT EXISTS legacy_serial_question_scores(
 exam_id INT NOT NULL,serial_no INT NOT NULL,question_number VARCHAR(32) NOT NULL,
 paper_id VARCHAR(64) NOT NULL,question_id VARCHAR(64) NOT NULL,kind VARCHAR(24) NOT NULL,
 score DOUBLE NULL,max_score DOUBLE NOT NULL,status VARCHAR(32) NOT NULL,
 source_record_id VARCHAR(64) NULL,source_version INT NOT NULL DEFAULT 0,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(exam_id,serial_no,question_number),KEY serial_score_paper(paper_id)
)`;
export async function ensureSerialScoreSchema(db:DbAdapter=getMysqlDb()){await db.exec(serialScoreSchema);}
export function serialScoreRows(def:PdfTemplate,results:Row[],marks:Row[]){
 return def.questions.map(q=>{
  const r=(q.gradingType==="objective"?results:marks).find(r=>r.question_id===q.questionId);
  return {number:q.displayNumber,id:q.questionId,kind:q.gradingType,score:r?.score==null?null:Number(r.score),
   max:q.maxScore,status:r?.status||"pending",record:r?.id||null,version:Number(r?.version||0)};
 });
}
export async function syncSerialScores(db:DbAdapter,paperId:string,def:PdfTemplate,results:Row[],marks:Row[]){
 const serial=await db.get<Row>("SELECT exam_id,serial_no FROM legacy_paper_serials WHERE paper_id=?",paperId);
 if(!serial)throw new Error("试卷缺少流水号，成绩未保存");
 // Names and student numbers never form part of a score key.
 const rows=serialScoreRows(def,results,marks);if(!rows.length)return;
 await db.run("DELETE FROM legacy_serial_question_scores WHERE paper_id=? AND (exam_id<>? OR serial_no<>?)",paperId,serial.exam_id,serial.serial_no);
 await db.run(`INSERT INTO legacy_serial_question_scores(exam_id,serial_no,question_number,paper_id,question_id,kind,score,max_score,status,source_record_id,source_version) VALUES ${rows.map(()=>"(?,?,?,?,?,?,?,?,?,?,?)").join(",")} ON DUPLICATE KEY UPDATE paper_id=VALUES(paper_id),question_id=VALUES(question_id),kind=VALUES(kind),score=VALUES(score),max_score=VALUES(max_score),status=VALUES(status),source_record_id=VALUES(source_record_id),source_version=VALUES(source_version)`,
 ...rows.flatMap(r=>[serial.exam_id,serial.serial_no,r.number,paperId,r.id,r.kind,r.score,r.max,r.status,r.record,r.version]));
}
export async function backfillSerialScores(db:DbAdapter=getMysqlDb()){
 const ts=await db.all<Row>("SELECT DISTINCT t.id,t.definition_json FROM legacy_pdf_templates t JOIN legacy_pdf_batches b ON b.template_id=t.id");
 for(const t of ts){
  const def=normalizePdfTemplate(typeof t.definition_json==="string"?JSON.parse(t.definition_json):t.definition_json);
  for(const q of def.questions){
   const table=q.gradingType==="objective"?"legacy_pdf_results":"legacy_pdf_marks";
   await db.run(`INSERT INTO legacy_serial_question_scores(exam_id,serial_no,question_number,paper_id,question_id,kind,score,max_score,status,source_record_id,source_version)
    SELECT s.exam_id,s.serial_no,?,p.id,?,?,r.score,?,COALESCE(r.status,'pending'),r.id,COALESCE(r.version,0)
    FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=b.exam_id
    LEFT JOIN ${table} r ON r.paper_id=p.id AND r.question_id=?
    LEFT JOIN legacy_serial_question_scores old ON old.exam_id=s.exam_id AND old.serial_no=s.serial_no AND old.question_number=?
    WHERE b.template_id=? AND (old.paper_id IS NULL OR old.source_version<>COALESCE(r.version,0) OR NOT(old.source_record_id<=>r.id) OR old.status<>COALESCE(r.status,'pending') OR NOT(old.score<=>r.score))
    ON DUPLICATE KEY UPDATE paper_id=VALUES(paper_id),question_id=VALUES(question_id),kind=VALUES(kind),score=VALUES(score),max_score=VALUES(max_score),status=VALUES(status),source_record_id=VALUES(source_record_id),source_version=VALUES(source_version)`,
    q.displayNumber,q.questionId,q.gradingType,q.maxScore,q.questionId,q.displayNumber,t.id);
  }
 }
}
