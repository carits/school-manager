-- Run only against school_manager_legacy. Runtime performs these checks only with PROJECTX_LEGACY_ONLY=1.
CREATE TABLE IF NOT EXISTS legacy_pdf_exam_keys (
 exam_id INT PRIMARY KEY,
 answers_json LONGTEXT NOT NULL,
 updated_by INT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
ALTER TABLE legacy_pdf_templates ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL;
