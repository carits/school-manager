import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, copyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { WEEK7_CHINESE_TEMPLATE as preset } from "../src/shared/externalPaperPreset";
import { validateExternalTemplate, validateExternalKey, scoreExternalObjective, assertScoreOnly, proposePageGroups, externalBlockId } from "../src/shared/externalPaper";
import { makeExternalFixture } from "./external-paper-fixture";
const root = await mkdtemp(path.join(tmpdir(), "external-paper-test-"));
process.env.PROJECTX_DB_PATH=path.join(root,"test.db");process.env.ANSWER_CARD_DATA_DIR=path.join(root,"data");
const useMaria=process.env.EXTERNAL_TEST_MARIADB==='1';
if(useMaria){assert.equal(process.env.PROJECTX_MARIADB_DATABASE,'external_paper_ci','Only a disposable external_paper_ci database may be tested');assert.ok(process.env.PROJECTX_MARIADB_HOST);}else for(const k of Object.keys(process.env)) if(k.startsWith('PROJECTX_MARIADB_')||k.startsWith('PROJECTX_MYSQL_')) delete process.env[k];
let passed=0;
function check(label:string,fn:()=>unknown){fn();passed++;console.log(`PASS ${label}`);}
async function rejects(label:string,fn:()=>Promise<unknown>){await assert.rejects(fn);passed++;console.log(`PASS ${label}`);}
const {initializeDatabase,getMysqlDb,closeDatabase}=await import('../src/server/db');
const core=await import('../src/server/services/externalPaper/core');
const files=await import('../src/server/services/externalPaper/files');
const worker=await import('../src/server/services/externalPaper/worker');
const review=await import('../src/server/services/externalPaper/review');
const {submitReviewCropScores}=await import('../src/server/services/ReviewService');
const {canGradeBlock,getPermittedBlocks}=await import('../src/apps/answer-card/server/middleware');
const {databaseTimestamp}=await import('../src/server/db/timestamp');
try {
 const t=validateExternalTemplate(preset),objs=t.questions.filter(q=>q.type==='objective'),subs=t.questions.filter(q=>q.type==='subjective');
 check('本卷题目与分值22+98=120',()=>{assert.equal(objs.length,10);assert.equal(subs.length,9);assert.equal(objs.reduce((s,q)=>s+q.maxScore,0),22);assert.equal(subs.reduce((s,q)=>s+q.maxScore,0),98);assert.equal(t.questions.find(q=>q.number===19)?.regions?.length,2);assert.equal(t.identity.cells.length,60);assert.equal(objs.reduce((s,q)=>s+q.options!.length,0),41);});
 check('区域越界及重复题号被拒绝',()=>{assert.throws(()=>validateExternalTemplate({...t,questions:[...t.questions,t.questions[0]]}));assert.throws(()=>validateExternalTemplate({...t,identity:{...t.identity,cells:t.identity.cells.slice(1)}}));});
 check('评分空白与零分区分、拒绝非法数值',()=>{assert.equal(assertScoreOnly(0,8,1),0);for(const value of [null,undefined,"",NaN,Infinity,-1,9,.5])assert.throws(()=>assertScoreOnly(value,8,1));assert.equal(assertScoreOnly(.5,8,.5),.5);});
 const key=validateExternalKey(t,Object.fromEntries(objs.map(q=>[q.number,{options:q.options!.slice(0,q.requiredSelections).map(o=>o.label),...(q.requiredSelections!>1?{partialScore:0}:{})}])));
 check('缺答案与不确定填涂不算零分',()=>{const q=objs[0];assert.equal(scoreExternalObjective(q,{questionNumber:q.number,selectedOptions:['A'],status:'clear'},undefined),null);assert.equal(scoreExternalObjective(q,{questionNumber:q.number,selectedOptions:['A'],status:'review'},key[q.number]),null);assert.equal(scoreExternalObjective(q,{questionNumber:q.number,selectedOptions:[],status:'blank'},key[q.number]),0);});
 check('五选二标准答案必须恰好两个',()=>assert.throws(()=>validateExternalKey(t,{'8':{options:['A']}})));
 check('扫描提议不删除异常页，不在奇数页分拆前后栈',()=>{assert.deepEqual(proposePageGroups([1,2,3,4,5],'interleaved'),[[1,2],[3,4],[5]]);assert.deepEqual(proposePageGroups([1,2,3],'fronts_first'),[]);assert.deepEqual(proposePageGroups([1,2,3,4],'backs_reverse'),[[1,4],[2,3]]);});
 initializeDatabase();const db=getMysqlDb();
 if(useMaria){assert.equal((await db.all('SHOW TABLES')).length,0,'MariaDB test requires an empty database');const {initMariadbSchema,ensureDefaultAdmin}=await import('../src/server/db');await initMariadbSchema();await ensureDefaultAdmin();}
 const addUser=async(name:string,role:number,number:string|null=null)=>(await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number,subject,teacher_role) VALUES (?,'unused-test-hash',?,?,?,'yuwen',?)",name,name,role,number,role===2?'subject_teacher':null)).lastInsertRowid;
 const admin=await addUser('test-admin',1),teacher=await addUser('test-teacher',2),other=await addUser('test-other',2),student=await addUser('test-student',3,'001234');
 const grade=(await db.run("INSERT INTO grades (name) VALUES ('test-grade')")).lastInsertRowid;
 const cls=(await db.run("INSERT INTO classes (grade_id,name) VALUES (?,'test-class')",grade)).lastInsertRowid;
 await db.run('INSERT INTO class_students (class_id,student_id) VALUES (?,?)',cls,student);
 await db.run("INSERT INTO teacher_classes (teacher_id,class_id,subject) VALUES (?,?,'yuwen')",teacher,cls);
 const exam=(await db.run("INSERT INTO exams (name,subject,grade_id,class_id,created_by,status) VALUES ('test-paper','yuwen',?,?,?,'draft')",grade,cls,admin)).lastInsertRowid;
 const templatePdf=path.join(root,'template.pdf');await makeExternalFixture(templatePdf,t);await core.configureExternalExam(exam,t,templatePdf,admin,db);
 check('配置写入已有考试与九个单评分工块',()=>assert.ok(exam));
 const assignments=Object.fromEntries(subs.map(q=>[q.number,{teacherIds:[teacher],classIds:[]}]));await core.saveExternalAssignments(exam,assignments,admin,db);
 assert.equal((await db.get<{n:number}>('SELECT COUNT(*) AS n FROM review_assignments WHERE exam_id=?',exam))?.n,9);passed++;console.log('PASS 按应考名单建立九个共享题目池');
 const copy=path.join(root,'scan1.pdf');await copyFile(templatePdf,copy);const batch=await worker.enqueueExternalPdf(exam,copy,'test-scan.pdf',admin,db);
 const copy2=path.join(root,'scan2.pdf');await copyFile(templatePdf,copy2);const same=await worker.enqueueExternalPdf(exam,copy2,'same.pdf',admin,db);
 check('同卷重复上传返回原批次并保留原PDF',()=>assert.equal(same.id,batch.id));await access(batch.source_path);
 await rejects('扫描开始后冻结模板，拒绝悄悄改版',()=>core.configureExternalExam(exam,t,templatePdf,admin,db));
 const pageIds:string[]=[];
 for(const page of t.pages){const dir=files.childPath(files.batchDirectory(exam,batch.id),`page-${page.number}`);await mkdir(dir,{recursive:true});const crops=[];
  for(const q of subs.filter(q=>q.regions!.some(r=>r.page===page.number))){const out=files.childPath(dir,`q${q.number}.png`);await sharp({create:{width:100,height:q.number===19?220:80,channels:3,background:'white'}}).png().toFile(out);crops.push({questionNumber:q.number,pageNumber:page.number,path:out,width:100,height:q.number===19?220:80});}
  const result={status:'ok',pageNumber:page.number,studentNumber:page.number===1?'001234':null,identityCertain:page.number===1,questions:objs.filter(q=>q.options![0].page===page.number).map(q=>({questionNumber:q.number,selectedOptions:key[q.number].options,status:'clear'})),crops};
  const pid=`${batch.id}_${page.number}`;pageIds.push(pid);await db.run('INSERT INTO external_paper_pages (id,batch_id,page_index,result_json) VALUES (?,?,?,?)',pid,batch.id,page.number,JSON.stringify(result));
 }
 await rejects('背面无考号不能单独猜归属',()=>core.confirmExternalSheet(exam,[pageIds[1]],'001234',admin,undefined,db));
 await rejects('未知考号不能猜名单',()=>core.confirmExternalSheet(exam,[pageIds[0]],'999999',admin,undefined,db));
 const sheet=await core.confirmExternalSheet(exam,[pageIds[0]],'001234',admin,undefined,db);
 assert.equal((await db.get<{n:number}>("SELECT COUNT(*) AS n FROM answer_block_crops WHERE exam_id=?",exam))?.n,8);passed++;console.log('PASS 缺作文页时第一页8道主观题可先批');
 assert.equal((await db.get<{total_score:number|null}>('SELECT total_score FROM student_scores WHERE exam_id=?',exam))?.total_score,null);passed++;console.log('PASS 缺页或答案未设时正式总分为空');
 await core.saveExternalKey(exam,key,admin,db);
 assert.equal((await db.get<{objective_score:number}>('SELECT objective_score FROM student_scores WHERE exam_id=?',exam))?.objective_score,22);passed++;console.log('PASS 客观题按已确认答案得22分');
 await rejects('未被分配的教师不能领卷',()=>review.claimExternalPaper(exam,6,other,false,db));
 assert.deepEqual(await getPermittedBlocks({id:other,role_id:2,role_name:'teacher',teacher_role:'subject_teacher'} as any,exam),[]);passed++;console.log('PASS 空分工不扩大为整场权限');
 const current=await review.claimExternalPaper(exam,6,teacher,false,db);
 const replay=(await review.claimExternalPaper(exam,6,teacher,false,db));check('刷新返回本人已领取而不抢第二份',()=>assert.equal(replay.id,current.id));
 await rejects('另一教师不能提交已领取卷',()=>review.submitExternalScore({examId:exam,cropId:current.id,userId:other,score:8,requestId:randomUUID(),claimCount:current.claimCount},db));
 await rejects('活跃领取未结束不允许改派',()=>core.saveExternalAssignments(exam,{'6':{teacherIds:[other],classIds:[]}},admin,db));
 const request=randomUUID();const submit=async(q:number,c:any,score:number,requestId=randomUUID(),editRound?:number)=>submitReviewCropScores({examId:exam,cropId:c.id,userId:teacher,blockTotalScore:score,scores:[{questionNumber:q,scoreType:'subjective',score}],requestId,claimCount:c.claimCount,...(editRound!==undefined?{editRound}:{})},db);
 const zero=await submit(6,current,0,request);assert.equal(zero.finalScore,0);passed++;console.log('PASS 无理由也能提交明确零分');
 assert.deepEqual(await submit(6,current,0,request),zero);passed++;console.log('PASS 保存超时重试幂等，不重复计分');
 await rejects('同请求号不同分数被拒绝',()=>submit(6,current,8,request));
 await rejects('初评分数已提交不能用旧领取覆盖',()=>submit(6,current,8));
 await submit(6,current,8,randomUUID(),zero.reviewRound);passed++;console.log('PASS 本人按评分轮次改分，自动留存前后分数');
 await core.confirmExternalSheet(exam,[pageIds[1]],'001234',admin,sheet,db);
 assert.equal((await db.get<{n:number}>("SELECT COUNT(*) AS n FROM answer_block_crops WHERE exam_id=?",exam))?.n,9);passed++;console.log('PASS 补作文页仅增加一个作文评分任务');
 assert.equal((await db.get<{score:number}>("SELECT score FROM question_scores WHERE exam_id=? AND question_number=6",exam))?.score,8);passed++;console.log('PASS 补扫保留第一页已批成绩');
 await rejects('未批完不能发布',()=>core.assertExternalScoresComplete(db,exam));
 for(const q of subs.filter(q=>q.number!==6)){const c=await review.claimExternalPaper(exam,q.number,teacher,false,db);await submit(q.number,c,q.maxScore);}
 await core.assertExternalScoresComplete(db,exam);assert.equal((await db.get<{total_score:number}>("SELECT total_score FROM student_scores WHERE exam_id=?",exam))?.total_score,120);passed++;console.log('PASS 九个主观题完成后总分120');
 const s=await db.get<core.ExternalSheetRow>('SELECT * FROM external_paper_sheets WHERE id=?',sheet);
 await core.confirmExternalAnswer(exam,sheet,1,['B'],s!.version,admin,db);
 assert.equal((await db.get<{total_score:number}>('SELECT total_score FROM student_scores WHERE exam_id=?',exam))?.total_score,118);passed++;console.log('PASS 纠正客观题后实时总分118，主观题不变');
 await rejects('过期客观题复核版本拒绝',()=>core.confirmExternalAnswer(exam,sheet,1,['A'],s!.version,admin,db));
 const nine=await db.get<{n:number}>('SELECT COUNT(*) AS n FROM answer_block_crops WHERE exam_id=?',exam);assert.equal(nine?.n,9);
 await rejects('已归属扫描页不可重复分配给第二份答卷',()=>core.confirmExternalSheet(exam,[pageIds[0]],'001234',admin,undefined,db));

 // Transactions on the one SQLite connection must isolate concurrent async requests.
 await db.exec("CREATE TABLE external_concurrency_test (value INTEGER)");
 await Promise.all(Array.from({length:8},(_,i)=>db.transactionWithNamedLock(`concurrent-${i}`,1000,async tx=>{await tx.run('INSERT INTO external_concurrency_test VALUES (?)',i);await new Promise(r=>setTimeout(r,3));})));
 assert.equal((await db.get<{n:number}>('SELECT COUNT(*) AS n FROM external_concurrency_test'))?.n,8);passed++;console.log('PASS 并发事务在异步让出期间不相互穿插');
 await rejects('失败事务回滚且不锁死后续请求',()=>db.transaction(async tx=>{await tx.run('INSERT INTO external_concurrency_test VALUES (100)');throw new Error('expected');}));
 assert.equal((await db.get<{n:number}>('SELECT COUNT(*) AS n FROM external_concurrency_test'))?.n,8);
 await db.run("UPDATE external_paper_batches SET status='processing',lease_until=0,worker_token='old-worker' WHERE id=?",batch.id);
 assert.equal(await worker.processNextExternalBatch(db),true);assert.equal((await db.get<{status:string}>('SELECT status FROM external_paper_batches WHERE id=?',batch.id))?.status,'ready');passed++;console.log('PASS 中断批次重启后复用已持久化页面恢复');
 const {createApp}=await import('../src/apps/answer-card/server/index');const {createServer}=await import('node:http');
 const app=await createApp();const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const {hashPassword}=await import('../src/server/db');const {authService}=await import('../src/server/services/AuthService');
  const hash=await hashPassword('fixture-only-password');for(const uid of [admin,teacher,other])await db.run('UPDATE users SET password_hash=? WHERE id=?',hash,uid);
  const adminToken=(await authService.login('test-admin','fixture-only-password')).token!;
  const teacherToken=(await authService.login('test-teacher','fixture-only-password')).token!;
  const otherToken=(await authService.login('test-other','fixture-only-password')).token!;
  const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`;
  const send=(suffix:string,token?:string,method='GET',body?:unknown)=>fetch(url+suffix,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const base=`/api/external-paper/exams/${exam}`;
  check('扫描状态匿名访问401',()=>{});assert.equal((await send(`${base}/status`)).status,401);
  assert.equal((await send(`${base}/status`,teacherToken)).status,403);passed++;console.log('PASS 普通阅卷教师不能读全场扫描及考号');
  const status=await send(`${base}/status`,adminToken);assert.equal(status.status,200);const view=await status.json() as any;assert.equal(view.configured,true);assert.ok(!JSON.stringify(view).includes(root));passed++;console.log('PASS 扫描状态仅返回安全字段，不暴露服务器路径');
  const oldScore=await send(`/api/review/exams/${exam}/block-crops/${current.id}/submit`,teacherToken,'POST',{scores:[{questionNumber:6,scoreType:'subjective',score:1}],blockTotalScore:1});assert.equal(oldScore.status,409);passed++;console.log('PASS 旧评分入口不能旁路覆盖现成答题卡分数');
  assert.equal((await send(`/api/exams/${exam}`,adminToken,'PATCH',{cardId:'other'})).status,409);passed++;console.log('PASS 已确认模板不能经旧考试接口重新绑定');
  const img=await send(`${base}/crops/${current.id}/image`,teacherToken);assert.equal(img.status,200);assert.match(img.headers.get('content-type')??'',/image/);await img.arrayBuffer();passed++;console.log('PASS 教师可读取本人题目图片');
  assert.equal((await send(`${base}/crops/${current.id}/image`,otherToken)).status,403);passed++;console.log('PASS 未分配教师无法越权读题目图片');
  const history=await send(`${base}/questions/6/history`,teacherToken);const h=await history.json() as any;assert.ok(h.rows.length===1&&!JSON.stringify(h).includes('studentNumber'));passed++;console.log('PASS 本人回看清单不包含考号姓名');
  const update=await send(`${base}/crops/${current.id}/score`,teacherToken,'POST',{score:7,claimCount:current.claimCount,editRound:h.rows[0].reviewRound,requestId:randomUUID()});const u=await update.json() as any;assert.equal(update.status,200,JSON.stringify(u));assert.equal(u.totalScore,117);passed++;console.log('PASS HTTP 只传分数即可改分并实时重算');
  const csv=await send(`${base}/export`,adminToken);const text=await csv.text();assert.equal(csv.status,200);assert.ok(text.includes('"117","已完成"'));passed++;console.log('PASS 导出读取数据库当前117分而非最初识别快照');
  const refused=await send(`${base}/crops/${current.id}/score`,teacherToken,'POST',{score:51,editRound:u.reviewRound,requestId:randomUUID()});assert.equal(refused.status,422);passed++;console.log('PASS HTTP 服务端拒绝超出满分');
  await core.saveExternalKey(exam,{},admin,db);
  const blocked=await send(`/api/exams/${exam}/publish`,adminToken,'POST',{});assert.equal(blocked.status,409);passed++;console.log('PASS 旧公布入口也检查缺少答案或未完成题目');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 console.log(`\n${passed} external-paper checks passed`);
} finally {closeDatabase();if(useMaria)await (await import('../src/server/db/mysql')).resetAdapter();await rm(root,{recursive:true,force:true}).catch(()=>{});}
