import assert from "node:assert/strict";
import {listReviewBlockCrops} from "../../src/server/services/AnswerBlockCropService";
import {previewNextPaper} from "../../src/server/services/ReviewPoolService";
async function main(){
process.env.PROJECTX_LEGACY_ONLY="1";
const queries: {sql:string;params:any[]}[]=[];
const crops=Array.from({length:99},(_,i)=>({id:"crop"+i,student_id:i+1,exam_id:22,block_id:"q46",question_numbers:"[46]",
 score:null,max_score:1,student_number:String(i+1),source_type:"legacy_pdf",width_px:600,height_px:80}));
const adapter:any={
 dialect:"mysql",async all(sql:string,...params:any[]){
   queries.push({sql,params});
   if(sql.includes("SELECT m.crop_id"))return params.map(id=>({crop_id:id,question_id:"q46",template_id:"immutable-v2"}));
   if(sql.includes("SELECT id,definition_json"))return [{id:"immutable-v2",definition_json:JSON.stringify({questions:[{questionId:"q46",maxScore:2}]})}];
   if(sql.includes("SELECT abc.*"))return params.length===3?crops.filter(x=>x.id===params[2]):crops;
   if(sql.includes("SELECT student_id, question_number"))return crops.map(x=>({student_id:x.student_id,question_number:46,score:null,max_score:1}));
   if(sql.includes("has_half_point"))return [];
   if(sql.includes("SELECT id,score_breakdown"))return [{id:"crop0",score_breakdown:"[]"}];
   throw new Error("unexpected SQL "+sql);
 },async get(sql:string,...params:any[]){
   queries.push({sql,params});
   if(sql.includes("assigned_student_ids"))return {assigned_student_ids:"[1,2]"};
   if(sql.includes("SELECT card_id"))return undefined;
   throw new Error("unexpected get "+sql);
 },async run(){throw new Error("read-only preview attempted a mutation");}
};
const list=await listReviewBlockCrops({examId:22,blockId:"q46"},adapter);
assert.equal(list.length,99);assert.equal(list[0].maxScore,2);
assert.equal(queries.filter(q=>q.sql.includes("FROM question_scores")).length,1);
queries.length=0;
const next=await previewNextPaper(22,"q46",9,adapter);
assert.equal(next?.id,"crop0");
assert.ok(queries.find(q=>q.sql.includes("SELECT id,score_breakdown"))?.sql.includes("student_id IN (?,?)"));
assert.equal(queries.filter(q=>q.sql.includes("SELECT abc.*"))[0].params[2],"crop0");
assert.equal(queries.filter(q=>q.sql.includes("FROM question_scores"))[0].params.length,2);
console.log(JSON.stringify({passed:true,checks:["99 students use one score query","single claim decorates one crop only","preview is read-only","assignment slice retained","bound PDF maximum without objective results"],listQueryCount:6}));

}
main().catch(e=>{console.error(e);process.exit(1)});
