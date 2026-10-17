import assert from "node:assert/strict";
import {assignPaperSerial} from "../../src/server/services/LegacyPaperSerialService";
import type {DbAdapter} from "../../src/server/db";
const identities=new Map<string,{student_id:number|null;student_number:string|null}>([
 ["chinese",{student_id:1,student_number:"000123"}],["unknown",{student_id:null,student_number:null}],
 ["english",{student_id:1,student_number:"000123"}],["second",{student_id:2,student_number:"000124"}]]);
const serials=new Map<string,number>([["21:u:1",10704],["21:u:3",42]]);
const papers=new Map<string,{exam_id:number;serial_no:number}>(),counters=new Map<number,number>();let audits=0;
const max=(e:number)=>Math.max(0,...[...serials].filter(([k])=>k.startsWith(e+":")).map(([,n])=>n));
let locked:number|null=null;
const db={
 async get(sql:string,...v:any[]){
  if(sql.includes("FROM exams")){locked=v[0];return {id:v[0]};}
  assert.notEqual(locked,null,"exam lock must precede all reads and writes");
  if(sql.includes("FROM legacy_pdf_papers"))return identities.get(v[0]);
  if(sql.includes("FROM legacy_exam_serials")&&sql.includes("identity_key"))return serials.has(v[0]+":"+v[1])?{serial_no:serials.get(v[0]+":"+v[1])}:undefined;
  if(sql.includes("FROM legacy_exam_serials"))return {n:max(v[0])};
  if(sql.includes("FROM legacy_exam_serial_counters"))return {next_no:counters.get(v[0])};
  if(sql.includes("FROM legacy_paper_serials")&&sql.includes("paper_id<>"))return [...papers].find(([id,p])=>p.exam_id===v[0]&&p.serial_no===v[1]&&id!==v[2])?.[1];
  if(sql.includes("FROM legacy_paper_serials"))return papers.get(v[0]);
  throw Error(sql);
 },
 async run(sql:string,...v:any[]){
  assert.notEqual(locked,null);
  if(sql.startsWith("INSERT IGNORE INTO legacy_exam_serial_counters")){if(!counters.has(v[0]))counters.set(v[0],max(v[0])+1);}
  else if(sql.startsWith("INSERT INTO legacy_exam_serials")){
   assert(![...serials].some(([k,n])=>k.startsWith(v[0]+":")&&n===v[2]),"same-exam serial collision");
   serials.set(v[0]+":"+v[1],v[2]);
  }else if(sql.startsWith("UPDATE legacy_exam_serial_counters"))counters.set(v[1],v[0]);
  else if(sql.startsWith("INSERT INTO legacy_paper_serials"))papers.set(v[0],{exam_id:v[1],serial_no:v[2]});
  else if(sql.startsWith("INSERT INTO legacy_pdf_audit"))audits++;
  else throw Error(sql);
 }
} as unknown as DbAdapter;
assert.equal(await assignPaperSerial(db,21,"chinese"),10704);
assert.equal(await assignPaperSerial(db,21,"unknown"),10705);
assert.equal(await assignPaperSerial(db,22,"english"),1);
const first=audits;identities.set("english",{student_id:1,student_number:"CHANGED"});assert.equal(await assignPaperSerial(db,22,"english"),1);assert.equal(audits,first,"editing an identity label must not change the serial");
assert.equal(await assignPaperSerial(db,22,"second"),2);
identities.set("unknown",{student_id:3,student_number:"000125"});
assert.equal(await assignPaperSerial(db,21,"unknown"),42);
assert.equal(serials.get("21:p:unknown"),10705,"retired reservation must not be reused");
await assert.rejects(assignPaperSerial(db,22,"chinese"),/重复卷/);
assert.equal(await assignPaperSerial(db,23,"chinese"),1,"rebinding is scoped to its target exam");
assert.equal(papers.get("chinese")?.exam_id,23);
console.log("Serial reference matching, leading zeros, independent exams, idempotence, reservations, late identity and exam rebinding verified.");
