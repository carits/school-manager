import path from "node:path";
import {realpath} from "node:fs/promises";
import {getMysqlDb,type DbAdapter} from "../db";

export const reviewImportSchema=[
`CREATE TABLE IF NOT EXISTS legacy_review_import_items(
 source_item_id VARCHAR(64) PRIMARY KEY,task_id VARCHAR(64) NOT NULL,
 source_student_id VARCHAR(64) NOT NULL,paper_id VARCHAR(64) NOT NULL,
 crop_id VARCHAR(64) NOT NULL UNIQUE,image_path TEXT NOT NULL,image_hash CHAR(64) NOT NULL,
 source_json LONGTEXT NOT NULL,imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY import_paper(paper_id))`,
`CREATE TABLE IF NOT EXISTS legacy_review_import_history(
 source_score_id VARCHAR(64) PRIMARY KEY,task_id VARCHAR(64) NOT NULL,
 paper_id VARCHAR(64) NOT NULL,mark_id VARCHAR(64) NOT NULL,score DOUBLE NOT NULL,
 max_score DOUBLE NOT NULL,reviewer_id INT NOT NULL,scored_at DATETIME NOT NULL,
 source_json LONGTEXT NOT NULL,KEY import_mark(mark_id,scored_at))`,
`CREATE TABLE IF NOT EXISTS legacy_review_import_events(
 source_event_id VARCHAR(64) PRIMARY KEY,task_id VARCHAR(64) NOT NULL,source_json LONGTEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS legacy_review_import_assignments(
 source_assignment_id VARCHAR(64) PRIMARY KEY,task_id VARCHAR(64) NOT NULL,
 source_json LONGTEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS legacy_review_import_runs(
 task_id VARCHAR(64) PRIMARY KEY,snapshot_hash CHAR(64) NOT NULL,
 report_json LONGTEXT NOT NULL,committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
];
export async function ensureReviewImportSchema(db:DbAdapter=getMysqlDb()){
 for(const sql of reviewImportSchema)await db.exec(sql);
 if(!await db.get("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='legacy_pdf_batches' AND COLUMN_NAME='source_kind'"))
  await db.exec("ALTER TABLE legacy_pdf_batches ADD COLUMN source_kind VARCHAR(24) NOT NULL DEFAULT 'scan'");
}
export async function importedCropImage(cropId:string):Promise<string|null>{
 const row=await getMysqlDb().get<{image_path:string}>("SELECT image_path FROM legacy_review_import_items WHERE crop_id=?",cropId);
 if(!row)return null;
 const root=path.join(process.env.ANSWER_CARD_DATA_DIR||path.resolve("data/answer-card"),"legacy-pdf","review-imports");
 const resolved=await realpath(row.image_path),allowed=await realpath(root);
 if(!resolved.startsWith(allowed+path.sep))throw new Error("迁移阅卷图片路径不合法");
 return resolved;
}
