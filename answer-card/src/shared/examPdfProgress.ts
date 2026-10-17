export interface ExamPdfProgress {
 examId:number; totalPapers:number; recognizedPapers:number; scoringCompletePapers:number;
 totalQuestions:number; recognizedQuestions:number; scoredQuestions:number;
 pendingPapers:number; waitingScoreQuestions:number; identityPending:number;
 queued:number; running:number; failed:number; pausedBatches:number; manualWaitingBatches:number;
 batches:Array<{id:string;name:string;mode:string;paused:boolean;requested:boolean}>;
}
export interface ExamQuestionColumn { number:string; kind:"objective"|"teacher_score"; maxScore:number;historical?:boolean;groupId?:string;title?:string }
export interface ExamQuestionSummary {
 questions:ExamQuestionColumn[]; total:number; page:number; pageSize:number;
 rows:Array<{paperId:string;batchName:string;sheetNo:number;serialNumber?:number|null;studentId:number|null;
 studentNumber:string|null;studentName:string|null;identityConfirmed:boolean;
 scores:Record<string,number|null>;historicalScores?:Record<string,number|null>;groupScores?:Record<string,number|null>;historicalQuestionNumbers?:string[];objectiveDone:number;objectiveRequired:number;
 subjectiveDone:number;subjectiveRequired:number;objectiveScore:number|null;
 subjectiveScore:number|null;totalScore:number|null;reprocessing:boolean}>;
}
