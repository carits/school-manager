ALTER TABLE legacy_pdf_results ADD COLUMN recognition_present TINYINT AS (auto_value IS NOT NULL OR final_value IS NOT NULL) VIRTUAL, ALGORITHM=INSTANT;
ALTER TABLE legacy_pdf_results ADD INDEX legacy_objective_progress_read(paper_id,question_id,recognition_present,status,score),ALGORITHM=INPLACE,LOCK=NONE;
