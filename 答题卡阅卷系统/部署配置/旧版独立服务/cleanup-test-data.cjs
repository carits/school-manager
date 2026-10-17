const fs=require('node:fs'),mysql=require('/app/node_modules/mysql2/promise'),assert=require('node:assert/strict');
(async()=>{assert.equal(process.env.PROJECTX_MARIADB_DATABASE,'school_manager_legacy');assert.equal(process.env.PROJECTX_MARIADB_HOST,'legacy-old-db');
const c=await mysql.createConnection({host:process.env.PROJECTX_MARIADB_HOST,user:process.env.PROJECTX_MARIADB_USER,password:process.env.PROJECTX_MARIADB_PASSWORD,database:process.env.PROJECTX_MARIADB_DATABASE});
const [exams]=await c.query("SELECT id FROM exams WHERE name LIKE '[验收]%'"),[cards]=await c.query("SELECT id FROM answer_cards WHERE title LIKE '[验收]%'"),[users]=await c.query("SELECT id FROM users WHERE username IN ('__legacy_test_admin','__legacy_test_teacher_1','__legacy_test_teacher_2','__legacy_test_student_1','__legacy_test_student_2')"),[templates]=await c.query("SELECT id FROM legacy_pdf_templates WHERE title LIKE '[验收]%'");
const [fk]=await c.query("SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL");
const quote=n=>{assert(/^[a-zA-Z0-9_]+$/.test(n));return '`'+n+'`'},seen=new Set();
async function remove(table,col,ids){if(!ids.length)return;const key=table+'|'+col+'|'+JSON.stringify(ids);if(seen.has(key))return;seen.add(key);const sql=quote(col)+' IN('+ids.map(()=>'?').join(',')+')';const [rows]=await c.query('SELECT * FROM '+quote(table)+' WHERE '+sql,ids);
for(const f of fk.filter(f=>f.REFERENCED_TABLE_NAME===table)){const vals=[...new Set(rows.map(r=>r[f.REFERENCED_COLUMN_NAME]).filter(v=>v!=null))];await remove(f.TABLE_NAME,f.COLUMN_NAME,vals)}
await c.query('DELETE FROM '+quote(table)+' WHERE '+sql,ids)}
await c.beginTransaction();
const [batches]=await c.query("SELECT b.id FROM legacy_pdf_batches b JOIN exams e ON e.id=b.exam_id WHERE e.name LIKE '[验收]%'");
const bids=batches.map(r=>r.id);if(bids.length){const qs=bids.map(()=>'?').join(','),[papers]=await c.query('SELECT id FROM legacy_pdf_papers WHERE batch_id IN('+qs+')',bids);const pids=papers.map(p=>p.id);
if(pids.length){const pqs=pids.map(()=>'?').join(',');await c.query('DELETE FROM legacy_pdf_marks WHERE paper_id IN('+pqs+')',pids);await c.query('DELETE FROM legacy_pdf_results WHERE paper_id IN('+pqs+')',pids)}
for(const table of ['legacy_pdf_jobs','legacy_pdf_pages','legacy_pdf_papers'])await c.query('DELETE FROM '+table+' WHERE batch_id IN('+qs+')',bids);await c.query('DELETE FROM legacy_pdf_batches WHERE id IN('+qs+')',bids)}
await remove('exams','id',exams.map(r=>r.id));await remove('answer_cards','id',cards.map(r=>r.id));
await remove('legacy_pdf_templates','id',templates.map(r=>r.id));
const uids=users.map(u=>u.id);if(uids.length){await c.query('UPDATE legacy_pdf_audit SET operator_id=NULL WHERE operator_id IN('+uids.map(()=>'?').join(',')+')',uids);await remove('users','id',uids)}
const [cols]=await c.query('SHOW COLUMNS FROM users');for(const col of cols.filter(c=>/api_key|api_secret|access_token|wechat_openid|initial_password/.test(c.Field))){await c.query('UPDATE users SET '+quote(col.Field)+'=?',[col.Null==='YES'?null:''])}
await c.commit();
const [left]=await c.query('SELECT COUNT(*) n FROM users'),[cl]=await c.query('SELECT COUNT(*) n FROM class_students'),[leftcards]=await c.query('SELECT COUNT(*) n FROM answer_cards'),[lefttmpl]=await c.query('SELECT id,title,status FROM legacy_pdf_templates');
assert.equal(Number(left[0].n),759);assert.equal(Number(cl[0].n),715);assert.equal(Number(leftcards[0].n),1);assert.equal(lefttmpl.length,1);assert.equal(lefttmpl[0].status,'draft');
console.log(JSON.stringify({removed:{exams:exams.length,cards:cards.length,users:users.length,templates:templates.length,batches:bids.length},remaining:{users:left[0].n,classStudents:cl[0].n,cards:leftcards[0].n,templates:lefttmpl}}));
await c.end();})().catch(e=>{console.error(e);process.exit(1)});
