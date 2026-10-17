CREATE TABLE IF NOT EXISTS legacy_pdf_templates (
 id VARCHAR(64) PRIMARY KEY, family_id VARCHAR(64) NOT NULL, revision INT NOT NULL, title VARCHAR(255) NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'draft', definition_json LONGTEXT NOT NULL,pdf_hash CHAR(64) NOT NULL,pdf_path TEXT NOT NULL,pages_json LONGTEXT NOT NULL,card_id VARCHAR(64) NULL,
 created_by INT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY template_revision(family_id,revision)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_batches (
 id VARCHAR(64) PRIMARY KEY,exam_id INT NOT NULL,template_id VARCHAR(64) NOT NULL,pdf_hash CHAR(64) NOT NULL,pdf_path TEXT NOT NULL,original_name VARCHAR(255) NOT NULL,answer_key_json LONGTEXT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'queued',total INT NOT NULL DEFAULT 0,finished INT NOT NULL DEFAULT 0,error TEXT NULL,created_by INT NOT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY batch_identity(exam_id,template_id,pdf_hash)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_papers (
 id VARCHAR(64) PRIMARY KEY,batch_id VARCHAR(64) NOT NULL,sheet_no INT NOT NULL,student_id INT NULL,
 auto_identity LONGTEXT NULL,identity_status VARCHAR(24) NOT NULL DEFAULT 'wait_confirm',ownership_confirmed TINYINT NOT NULL DEFAULT 0,version INT NOT NULL DEFAULT 0,
 UNIQUE KEY batch_sheet(batch_id,sheet_no),UNIQUE KEY batch_student(batch_id,student_id)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_pages (
 id VARCHAR(64) PRIMARY KEY,batch_id VARCHAR(64) NOT NULL,paper_id VARCHAR(64) NULL,source_page INT NOT NULL,page_role VARCHAR(64) NOT NULL,
 raw_path TEXT NOT NULL,aligned_path TEXT NULL,status VARCHAR(24) NOT NULL DEFAULT 'pending',alignment_json LONGTEXT NULL,recognition_json LONGTEXT NULL,manual_json LONGTEXT NULL,version INT NOT NULL DEFAULT 0,
 UNIQUE KEY batch_page(batch_id,source_page)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_results (
 id VARCHAR(64) PRIMARY KEY,paper_id VARCHAR(64) NOT NULL,question_id VARCHAR(64) NOT NULL,
 auto_value LONGTEXT NULL,final_value LONGTEXT NULL,status VARCHAR(24) NOT NULL DEFAULT 'wait_confirm',
 confidence DOUBLE NULL,score DOUBLE NULL,final_source VARCHAR(24) NULL,recognizer_version VARCHAR(80) NULL,version INT NOT NULL DEFAULT 0, UNIQUE KEY paper_question(paper_id,question_id)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_marks (
 id VARCHAR(64) PRIMARY KEY,paper_id VARCHAR(64) NOT NULL,question_id VARCHAR(64) NOT NULL,crop_id VARCHAR(64) NOT NULL,
 version INT NOT NULL DEFAULT 0,score DOUBLE NULL,status VARCHAR(24) NOT NULL DEFAULT 'ready', UNIQUE KEY paper_question(paper_id,question_id),UNIQUE KEY crop_link(crop_id)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_audit (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,entity_type VARCHAR(32) NOT NULL,entity_id VARCHAR(64) NOT NULL,
 action VARCHAR(64) NOT NULL,operator_id INT NULL,before_json LONGTEXT NULL,after_json LONGTEXT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX entity_history(entity_type,entity_id)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_jobs (
 batch_id VARCHAR(64) PRIMARY KEY,status VARCHAR(24) NOT NULL DEFAULT 'queued',attempts INT NOT NULL DEFAULT 0,
 lease_until DATETIME NULL,error TEXT NULL,kind VARCHAR(24) NOT NULL DEFAULT 'scan',run_id VARCHAR(64) NULL,payload_json LONGTEXT NULL,priority INT NOT NULL DEFAULT 0,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS legacy_pdf_qr_locators (
 template_id VARCHAR(64) NOT NULL,page_role VARCHAR(64) NOT NULL,rect_json LONGTEXT NULL,
 revision INT NOT NULL DEFAULT 1,updated_by INT NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(template_id,page_role)
);
CREATE TABLE IF NOT EXISTS legacy_pdf_batch_locators (
 batch_id VARCHAR(64) PRIMARY KEY,settings_json LONGTEXT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS legacy_pdf_stage_jobs (
 id VARCHAR(64) PRIMARY KEY,queue_no BIGINT NOT NULL AUTO_INCREMENT UNIQUE,batch_id VARCHAR(64) NOT NULL,paper_id VARCHAR(64) NULL,page_id VARCHAR(64) NULL,
 kind VARCHAR(24) NOT NULL,input_hash CHAR(64) NOT NULL,algorithm_version VARCHAR(80) NOT NULL,
 priority INT NOT NULL,status VARCHAR(24) NOT NULL DEFAULT 'queued',payload_json LONGTEXT NOT NULL,
 attempts INT NOT NULL DEFAULT 0,lease_until DATETIME NULL,error TEXT NULL,created_by INT NULL,
 created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY stage_input(kind,input_hash),INDEX stage_queue(status,priority,created_at),INDEX stage_batch(batch_id)
);
