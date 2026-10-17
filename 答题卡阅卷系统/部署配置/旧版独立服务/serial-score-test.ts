import assert from "node:assert/strict";
import {serialScoreRows,syncSerialScores} from "../../源码/server/services/LegacySerialScoreService";
import {normalizePdfTemplate} from "../../源码/shared/legacyPdf";
import type {DbAdapter} from "../../源码/server/db";
const def=normalizePdfTemplate({title:"test",pages:[{role:"front",width:210,height:297}],questions:[
 {questionId:"q1",displayNumber:"1",gradingType:"objective",maxScore:2,options:[]},
 {questionId:"q6",displayNumber:"6",gradingType:"teacher_score",maxScore:8,regions:[]}]});
const results=[{id:"result",question_id:"q1",score:0,status:"confirmed",version:3}],marks=[{id:"mark",question_id:"q6",score:6,status:"reviewed",version:4}];
const rows=serialScoreRows(def,results,marks);
assert.equal(rows[0].score,0);assert.equal(rows[1].score,6);
assert.equal(serialScoreRows(def,[],[])[0].score,null);
let writes:Array<{sql:string,args:any[]}>=[];
const db={async get(){return {exam_id:21,serial_no:10704};},async run(sql:string,...args:any[]){writes.push({sql,args});}} as unknown as DbAdapter;
await syncSerialScores(db,"paper",def,results,marks);
const insert=writes.find(w=>w.sql.startsWith("INSERT"))!;
assert.deepEqual(insert.args.slice(0,3),[21,10704,"1"]);
assert.deepEqual(insert.args.slice(11,14),[21,10704,"6"]);
assert(!insert.sql.includes("student_id"));assert(!insert.sql.includes("student_number"));assert(!insert.sql.includes("student_name"));
writes=[];await syncSerialScores(db,"paper",def,results,marks);
assert.deepEqual(writes.find(w=>w.sql.startsWith("INSERT"))!.args,insert.args);
await assert.rejects(syncSerialScores({async get(){return null;}} as unknown as DbAdapter,"missing",def,results,marks),/缺少流水号/);
console.log("Score keys are exam/serial/question; zero, pending and teacher scores preserved; identity is absent from score storage; missing serial blocks saving.");
