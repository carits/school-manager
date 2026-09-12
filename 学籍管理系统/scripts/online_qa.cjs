const {chromium}=require('C:/Users/陈灿华/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs'),path=require('path');const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');
const base='http://47.99.222.76';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 if(process.argv[2]==='prepare'){
  const ctx=await browser.newContext({viewport:{width:390,height:844}});const page=await ctx.newPage();
  await page.goto(base+'/xueji/');await page.locator('#captcha-image').screenshot({path:path.join(out,'online-captcha.png')});
  await page.screenshot({path:path.join(out,'online-mobile-login.png'),fullPage:true});
  const csrf=await page.locator('[name=csrfmiddlewaretoken]').inputValue();
  fs.writeFileSync(path.join(out,'online-csrf.json'),JSON.stringify({csrf}));await ctx.storageState({path:path.join(out,'online-state.json')});
  console.log('Public login and captcha loaded.');
 }else{
  const ctx=await browser.newContext({viewport:{width:390,height:844},storageState:path.join(out,'online-state.json')});const page=await ctx.newPage();page.setDefaultNavigationTimeout(90000);page.setDefaultTimeout(90000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push(r.status()+' '+r.url())});
  const csrf=JSON.parse(fs.readFileSync(path.join(out,'online-csrf.json'))).csrf;
  const res=await ctx.request.post(base+'/xueji/',{form:{csrfmiddlewaretoken:csrf,name:'演示学生甲',number:'DEMO2026001',captcha:process.argv[3]}});
  if(!res.url().includes('/check/1/'))throw Error('Public captcha/login rejected');
  for(let i=1;i<=4;i++){
   await page.goto(base+'/xueji/check/'+i+'/');await page.locator('input[type=radio][value=correct]').evaluateAll(es=>es.forEach(e=>e.click()));
   if(i===3){await page.locator('[name=result_AA][value=incorrect]').check();await page.locator('[name=value_AA]').fill('公网演示核对地址 88 号（虚构）');}
   await page.getByRole('button',{name:/保存并进入下一步/}).click();
  }
  await page.locator('[name=ack]').check();await page.getByRole('button',{name:'确认提交',exact:true}).click();
  await page.getByRole('heading',{name:'学籍信息已提交'}).waitFor();await page.screenshot({path:path.join(out,'online-mobile-result.png'),fullPage:true});
  const admin=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const p=await admin.newPage();
  const creds=fs.readFileSync(path.join(root,'deployment-admin.txt'),'utf8');
  await p.goto('http://127.0.0.1:18091/xueji/manage/');
  await p.locator('[name=username]').fill(creds.match(/Username: (.+)/)[1].trim());await p.locator('[name=password]').fill(creds.match(/Password: (.+)/)[1].trim());
  await p.locator('[type=submit]').click();await p.getByRole('heading',{name:'核对工作台'}).waitFor();
  await p.screenshot({path:path.join(out,'online-admin-dashboard.png'),fullPage:true});
  for(const [text,file] of [['学籍最终数据','online-final.xlsx'],['家长修改明细','online-changes.xlsx'],['未完成名单','online-pending.xlsx']]){
   const wait=p.waitForEvent('download');await p.getByRole('link',{name:new RegExp(text)}).click();const download=await wait;await download.saveAs(path.join(out,file));
  }
  const wait=p.waitForEvent('download');await p.getByRole('link',{name:'下载入口二维码'}).click();await(await wait).saveAs(path.join(root,'student-check-qr.png'));
  // Restore the fictional student's availability through the actual administrator UI.
  await p.getByRole('link',{name:'查看',exact:true}).first().click();p.on('dialog',d=>d.accept());await p.getByRole('button',{name:'重新开放核对'}).click();
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({passed:true,public_captcha_login:true,public_four_step_submit:true,admin_password_login_via_tunnel:true,exports:3,qr_download:true,demo_reopened:true,errors}));
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
