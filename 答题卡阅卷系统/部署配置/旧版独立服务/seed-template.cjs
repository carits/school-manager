const fs=require('node:fs'),mysql=require('/app/node_modules/mysql2/promise');
(async()=>{const state=JSON.parse(fs.readFileSync('/app/data/answer-card/legacy-pdf/tests/state.json'));
const c=await mysql.createConnection({host:process.env.PROJECTX_MARIADB_HOST,user:process.env.PROJECTX_MARIADB_USER,password:process.env.PROJECTX_MARIADB_PASSWORD,database:process.env.PROJECTX_MARIADB_DATABASE});
const [existing]=await c.query("SELECT id FROM legacy_pdf_templates WHERE title NOT LIKE '[验收]%' AND status='draft'");
if(!existing.length){const r=await fetch('http://127.0.0.1:5174/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:state.users[0].name,password:state.password})});const cookie=r.headers.get('set-cookie').split(';')[0];
const f=new FormData();f.append('file',new Blob([fs.readFileSync('/tmp/week7-sample.pdf')],{type:'application/pdf'}),'语文第七周模板.pdf');f.append('definition',fs.readFileSync('/tmp/week7-template.json','utf8'));const a=await fetch('http://127.0.0.1:5174/api/templates',{method:'POST',headers:{Cookie:cookie},body:f});const d=await a.json();if(!a.ok)throw Error(JSON.stringify(d));console.log(JSON.stringify({seed:d}));
const [admins]=await c.query("SELECT id FROM users WHERE role_id=1 AND username NOT LIKE '__legacy_test_%' ORDER BY id LIMIT 1");if(admins.length)await c.query('UPDATE legacy_pdf_templates SET created_by=? WHERE id=?',[admins[0].id,d.id]);
} else console.log('draft exists');
await c.end();})().catch(e=>{console.error(e);process.exit(1)});
