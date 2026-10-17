import type {DbAdapter} from "../db";
import type {PdfTemplate} from "../../shared/legacyPdf";
type Row=Record<string,any>;
export type LegacyReviewGroupMode="draft"|"transition"|"active"|"readonly";
export interface LegacyReviewGroup {
 exam_id:number;group_id:string;title:string;questions_json:string;questions:number[];
 max_score:number;mode:LegacyReviewGroupMode;created_at?:string;updated_at?:string;
}
export interface LegacyReviewGroupScore {
 exam_id:number;serial_no:number;group_id:string;paper_id:string;score:number|null;max_score:number;
 status:"ready"|"reviewed";version:number;graded_by:number|null;graded_at:string|null;
 source:"existing_sum"|"teacher";claimed_by:number|null;claimed_at:string|null;input_signature:string|null;
}
export interface LegacyReviewGroupScoreContext {groups:LegacyReviewGroup[];scores:LegacyReviewGroupScore[]}
export const LEGACY_REVIEW_GROUP_EXAM_ID=22;
export const LEGACY_REVIEW_GROUP_MEMBERS:Readonly<Record<string,readonly number[]>>={
 "english-46-55":Array.from({length:10},(_,i)=>46+i),
 "english-56-60":Array.from({length:5},(_,i)=>56+i)
};
export const reviewGroupSchema=[
 `CREATE TABLE IF NOT EXISTS legacy_review_groups(
 exam_id INT NOT NULL,group_id VARCHAR(64) NOT NULL,title VARCHAR(255) NOT NULL,
 questions_json LONGTEXT NOT NULL,max_score DOUBLE NOT NULL,
 mode ENUM('draft','transition','active','readonly') NOT NULL DEFAULT 'draft',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(exam_id,group_id))`,
 `CREATE TABLE IF NOT EXISTS legacy_review_group_scores(
 exam_id INT NOT NULL,serial_no INT NOT NULL,group_id VARCHAR(64) NOT NULL,paper_id VARCHAR(64) NOT NULL,
 score DOUBLE NULL,max_score DOUBLE NOT NULL,status ENUM('ready','reviewed') NOT NULL DEFAULT 'ready',
 version INT NOT NULL DEFAULT 0,graded_by INT NULL,graded_at DATETIME(3) NULL,
 source ENUM('existing_sum','teacher') NOT NULL DEFAULT 'existing_sum',
 claimed_by INT NULL,claimed_at DATETIME(3) NULL,input_signature VARCHAR(255) NULL,
 PRIMARY KEY(exam_id,serial_no,group_id),KEY legacy_group_score_paper(paper_id))`
];
/** DDL only. App init owns invocation; this never activates or backfills groups. */
export async function ensureReviewGroupSchema(adapter?:DbAdapter){
 if(process.env.PROJECTX_LEGACY_ONLY!=="1")throw new Error("Review group schema is limited to the legacy service");
 const db=adapter??(await import("../db")).getMysqlDb();
 for(const sql of reviewGroupSchema)await db.exec(sql);
}
export function normalizeLegacyReviewGroup(row:Row):LegacyReviewGroup|null{
 const members=LEGACY_REVIEW_GROUP_MEMBERS[String(row.group_id)];
 if(Number(row.exam_id)!==22||!members)return null;
 const input=typeof row.questions_json==="string"?JSON.parse(row.questions_json):row.questions_json;
 if(!Array.isArray(input))throw new Error("Invalid legacy review group questions");
 const questions=input.map((q:any)=>Number(typeof q==="object"&&q!==null?q.questionNumber??q.displayNumber??q.number:q));
 if(questions.length!==members.length||new Set(questions).size!==members.length||members.some(n=>!questions.includes(n)))
  throw new Error("Invalid legacy review group membership: "+row.group_id);
 const max=Number(row.max_score);
 if(!Number.isFinite(max)||max<0)throw new Error("Invalid legacy review group maximum");
 return {...row,exam_id:Number(row.exam_id),group_id:String(row.group_id),questions:[...members],questions_json:JSON.stringify(members),max_score:max} as LegacyReviewGroup;
}
/** Locking reads belong inside the caller's transaction. Draft rows are locked too. */
export async function readReviewGroups(adapter:DbAdapter,examId:number,lock=false):Promise<LegacyReviewGroup[]>{
 if(process.env.PROJECTX_LEGACY_ONLY!=="1"||Number(examId)!==22)return [];
 const rows=await adapter.all<Row>("SELECT * FROM legacy_review_groups WHERE exam_id=? ORDER BY group_id"+(lock?" FOR UPDATE":""),examId);
 return rows.map(normalizeLegacyReviewGroup).filter((g):g is LegacyReviewGroup=>g!==null);
}
/** Active means the old question workflow is disabled: transition / active / readonly. */
export async function readActiveReviewGroups(adapter:DbAdapter,examId:number):Promise<LegacyReviewGroup[]>{
 return (await readReviewGroups(adapter,examId)).filter(g=>["transition","active","readonly"].includes(g.mode));
}
/** Shared with parent claim guards. Lock config even when currently draft. */
export async function assertLegacyQuestionNotGrouped(adapter:DbAdapter,examId:number,questionNumber:string|number){
 const groups=await readReviewGroups(adapter,examId,true);
 if(groups.some(g=>["transition","active","readonly"].includes(g.mode)&&g.questions.includes(Number(questionNumber))))
  throw Object.assign(new Error("刷新合并阅卷"),{status:409});
}
/** Read-only; exam+serial+paper prevents a stale identity from inheriting another total. */
export async function readReviewGroupScoreContext(adapter:DbAdapter,examId:number,paperIds?:string[],lock=false):Promise<LegacyReviewGroupScoreContext>{
 if(process.env.PROJECTX_LEGACY_ONLY!=="1"||Number(examId)!==22)return {groups:[],scores:[]};
 const groups=await readReviewGroups(adapter,examId,lock);
 if(paperIds&&!paperIds.length)return {groups,scores:[]};
 const scores=await adapter.all<LegacyReviewGroupScore>(`SELECT g.* FROM legacy_review_group_scores g
 JOIN legacy_paper_serials s ON s.exam_id=g.exam_id AND s.serial_no=g.serial_no AND s.paper_id=g.paper_id
 WHERE g.exam_id=?${paperIds?` AND g.paper_id IN (${paperIds.map(()=>"?").join(",")})`:""} ORDER BY g.group_id`+(lock?" FOR UPDATE":""),examId,...(paperIds||[]));
 // Persisted totals remain effective if rollback removed the config row.
 for(const record of scores){
  const members=LEGACY_REVIEW_GROUP_MEMBERS[record.group_id];
  if(members&&!groups.some(g=>g.group_id===record.group_id)&&record.score!=null)
   groups.push({exam_id:examId,group_id:record.group_id,title:record.group_id,questions:[...members],questions_json:JSON.stringify(members),max_score:Number(record.max_score),mode:"draft"});
 }
 return {groups,scores:scores.filter(s=>!!LEGACY_REVIEW_GROUP_MEMBERS[s.group_id])};
}
const validScore=(v:any)=>v!=null&&v!==""&&Number.isFinite(Number(v));
export interface LegacyEffectivePaperScore {
 scores:Record<string,number|null>;historicalScores:Record<string,number|null>;
 groupScores:Record<string,number|null>;historicalQuestionNumbers:string[];
 objective:number;subjective:number;objectiveDone:number;subjectiveDone:number;
 objectiveRequired:number;subjectiveRequired:number;objectiveComplete:boolean;
 subjectiveComplete:boolean;scoringComplete:boolean;total:number|null;
}
/** Pure: replace child marks ONCE; never mutate or split into the question ledger. */
export function effectiveLegacyPaperScores(input:{examId:number;paperId:string;serialNumber?:number|null;def:Pick<PdfTemplate,"questions">;results:Row[];marks:Row[];groups?:LegacyReviewGroup[];groupScores?:LegacyReviewGroupScore[]}):LegacyEffectivePaperScore{
 const scores:Record<string,number|null>={},historicalScores:Record<string,number|null>={},groupScores:Record<string,number|null>={};
 let objective=0,subjective=0,objectiveDone=0,subjectiveDone=0,objectiveRequired=0,subjectiveRequired=0;
 const groups=Number(input.examId)===22?(input.groups||[]).filter(g=>Number(g.exam_id)===22&&!!LEGACY_REVIEW_GROUP_MEMBERS[g.group_id]):[];
 const replacements=new Map<string,{group:LegacyReviewGroup;record?:LegacyReviewGroupScore}>();
 for(const group of groups){
  const record=(input.groupScores||[]).find(s=>Number(s.exam_id)===Number(input.examId)&&s.paper_id===input.paperId&&input.serialNumber!=null&&Number(s.serial_no)===Number(input.serialNumber)&&s.group_id===group.group_id);
  if(group.mode!=="draft"||record?.score!=null)replacements.set(group.group_id,{group,record});
 }
 const historicalQuestionNumbers:string[]=[];
 for(const q of input.def.questions){
  const isObjective=q.gradingType==="objective",r=(isObjective?input.results:input.marks).find(r=>r.question_id===q.questionId);
  const ready=r?.status===(isObjective?"confirmed":"reviewed")&&validScore(r?.score),value=ready?Number(r!.score):null;
  scores[q.displayNumber]=value;
  if([...replacements.values()].some(({group})=>group.questions.includes(Number(q.displayNumber)))){
   if(isObjective)throw new Error("Legacy review groups may only replace subjective questions");
   historicalQuestionNumbers.push(q.displayNumber);historicalScores[q.displayNumber]=value;continue;
  }
  if(isObjective){objectiveRequired++;if(ready){objectiveDone++;objective+=value!;}}
  else{subjectiveRequired++;if(ready){subjectiveDone++;subjective+=value!;}}
 }
 for(const {group,record} of replacements.values()){
  // Ignore config for a different template instead of adding a phantom requirement.
  if(!input.def.questions.some(q=>group.questions.includes(Number(q.displayNumber))))continue;
  const ready=record?.status==="reviewed"&&validScore(record.score)&&Number(record!.score)>=0&&Number(record!.score)<=Number(record!.max_score);
  const value=ready?Number(record!.score):null;
  groupScores[group.group_id]=value;scores[group.group_id]=value;subjectiveRequired++;
  if(ready){subjectiveDone++;subjective+=value!;}
 }
 const objectiveComplete=objectiveDone===objectiveRequired,subjectiveComplete=subjectiveDone===subjectiveRequired,scoringComplete=objectiveComplete&&subjectiveComplete;
 return {scores,historicalScores,groupScores,historicalQuestionNumbers,objective,subjective,objectiveDone,subjectiveDone,objectiveRequired,subjectiveRequired,objectiveComplete,subjectiveComplete,scoringComplete,total:scoringComplete?objective+subjective:null};
}
/** Preserve child columns explicitly as history; add one total column per group. */
export function legacyGroupedQuestionColumns<T extends {number:string}>(questions:T[],groups:LegacyReviewGroup[],records:LegacyReviewGroupScore[]=[]):Array<T&{historical?:boolean;groupId?:string;title?:string}>{
 const effective=groups.filter(g=>g.mode!=="draft"||records.some(s=>s.group_id===g.group_id&&s.score!=null));
 const columns:Array<T&{historical?:boolean;groupId?:string;title?:string}>=questions.map(q=>({...q,...(effective.some(g=>g.questions.includes(Number(q.number)))?{historical:true,title:"第"+q.number+"题（历史）"}:{})}));
 for(const g of effective)if(questions.some(q=>g.questions.includes(Number(q.number))))columns.push({...questions.find(q=>g.questions.includes(Number(q.number)))!,number:g.group_id,kind:"teacher_score",maxScore:g.max_score,groupId:g.group_id,title:g.title,historical:false});
 return columns;
}

export interface LegacyReviewGroupExportData {
 questions:Array<{number:string;kind:"objective"|"teacher_score";maxScore:number;historical?:boolean;groupId?:string;title?:string}>;
 rows:Array<LegacyEffectivePaperScore&{studentId:number|null;paperId:string;serialNumber:number|null;identityConfirmed:boolean}>;
}
/** Read-only overlay for CSV/custom XLSX integrations; child columns are explicitly historical. */
export async function readLegacyReviewGroupExport(adapter:DbAdapter,examId:number):Promise<LegacyReviewGroupExportData|null>{
 if(process.env.PROJECTX_LEGACY_ONLY!=="1"||Number(examId)!==22)return null;
 const context=await readReviewGroupScoreContext(adapter,examId);
 if(!context.groups.some(g=>g.mode!=="draft"||context.scores.some(s=>s.group_id===g.group_id&&s.score!=null)))return null;
 const papers=await adapter.all<Row>("SELECT p.*,b.template_id,s.serial_no serialNumber FROM legacy_pdf_papers p JOIN legacy_pdf_batches b ON b.id=p.batch_id LEFT JOIN legacy_paper_serials s ON s.paper_id=p.id AND s.exam_id=b.exam_id WHERE b.exam_id=? ORDER BY p.id",examId);
 const templates=await adapter.all<Row>("SELECT DISTINCT t.id,t.definition_json FROM legacy_pdf_templates t JOIN legacy_pdf_batches b ON b.template_id=t.id WHERE b.exam_id=?",examId);
 const defs=new Map<string,Pick<PdfTemplate,"questions">>(templates.map(t=>{const def=typeof t.definition_json==="string"?JSON.parse(t.definition_json):t.definition_json;return [String(t.id),{questions:def.questions.map((q:Row)=>({...q,displayNumber:String(q.displayNumber)}))}];}));
 const ledger=await adapter.all<Row>("SELECT s.* FROM legacy_serial_question_scores s JOIN legacy_paper_serials p ON p.paper_id=s.paper_id AND p.exam_id=s.exam_id AND p.serial_no=s.serial_no WHERE s.exam_id=?",examId);
 const columns=new Map<string,{number:string;kind:"objective"|"teacher_score";maxScore:number}>();
 for(const def of defs.values())for(const q of def.questions)columns.set(q.displayNumber,{number:q.displayNumber,kind:q.gradingType,maxScore:q.maxScore});
 const questions=legacyGroupedQuestionColumns([...columns.values()].sort((a,b)=>Number(a.number)-Number(b.number)),context.groups,context.scores);
 const rows=papers.map(p=>{
  const def=defs.get(String(p.template_id));if(!def)throw new Error("Missing legacy paper template");
  const records=ledger.filter(s=>s.paper_id===p.id&&Number(s.serial_no)===Number(p.serialNumber));
  const effective=effectiveLegacyPaperScores({examId,paperId:p.id,serialNumber:p.serialNumber,def,results:records.filter(s=>s.kind==="objective"),marks:records.filter(s=>s.kind==="teacher_score"),groups:context.groups,groupScores:context.scores});
  return {...effective,studentId:p.student_id==null?null:Number(p.student_id),paperId:String(p.id),serialNumber:p.serialNumber==null?null:Number(p.serialNumber),identityConfirmed:p.identity_status==="confirmed"&&!!p.ownership_confirmed};
 });
 return {questions,rows};
}
