-- Old database only: school_manager_legacy. No review tables or credentials.
CREATE TABLE IF NOT EXISTS legacy_exam_serials (
 exam_id INT NOT NULL,identity_key VARCHAR(100) NOT NULL,serial_no INT NOT NULL,
 source VARCHAR(24) NOT NULL DEFAULT 'local',reference_task_id VARCHAR(64) NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(exam_id,identity_key),UNIQUE KEY exam_serial_number(exam_id,serial_no)
);

CREATE TABLE IF NOT EXISTS legacy_paper_serials (
 paper_id VARCHAR(64) NOT NULL,exam_id INT NOT NULL,serial_no INT NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(paper_id),UNIQUE KEY exam_paper_serial(exam_id,serial_no)
);

CREATE TABLE IF NOT EXISTS legacy_exam_serial_counters (
 exam_id INT PRIMARY KEY,next_no INT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_serial_question_scores(
 exam_id INT NOT NULL,serial_no INT NOT NULL,question_number VARCHAR(32) NOT NULL,
 paper_id VARCHAR(64) NOT NULL,question_id VARCHAR(64) NOT NULL,kind VARCHAR(24) NOT NULL,
 score DOUBLE NULL,max_score DOUBLE NOT NULL,status VARCHAR(32) NOT NULL,
 source_record_id VARCHAR(64) NULL,source_version INT NOT NULL DEFAULT 0,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(exam_id,serial_no,question_number),KEY serial_score_paper(paper_id)
);
