const {chromium}=require('C:/Users/陈灿华/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {execFileSync}=require('child_process');
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');const base=process.env.QA_BASE||'http://127.0.0.1:8091';
function session(admin=false){
 const code=`import os;os.environ['DJANGO_SETTINGS_MODULE']='config.settings';import django;django.setup();from django.contrib.sessions.backends.db import SessionStore;from checks.models import Student;from django.contrib.auth import get_user_model; s=SessionStore(); ${admin?"u=get_user_model().objects.get(username='school_admin');s['_auth_user_id']=str(u.pk);s['_auth_user_backend']='django.contrib.auth.backends.ModelBackend';s['_auth_user_hash']=u.get_session_auth_hash()":"s['student_id']=str(Student.objects.get(source_row=2,batch__active=True).pk)"};s.save();print(s.session_key)`;
 return execFileSync(path.join(root,'.venv/Scripts/python.exe'),['-c',code],{cwd:root,encoding:'utf8'}).trim();
}
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});const out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});const page=await context.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push(r.status()+' '+r.url())});
 await page.goto(base+'/xueji/');await page.screenshot({path:path.join(out,'mobile-login.png'),fullPage:true});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 await page.goto(base+'/xueji/progress/');await page.getByRole('heading',{name:'按班查看学生核对情况'}).waitFor();
 if(!await page.getByRole('link',{name:'查看本班学生'}).first().isVisible())throw Error('Public mobile class action is not visible');
 await page.getByRole('link',{name:'查看本班学生'}).first().click();await page.locator('#class-pending-list').waitFor();
 if(await page.getByRole('heading',{name:'按班查看学生核对情况'}).count())throw Error('Selected class still shows all-class heading');
 if(!await page.getByRole('link',{name:'返回班级列表'}).isVisible())throw Error('Return to class list action missing');
 if(!await page.getByRole('link',{name:/未核对/}).isVisible()||!await page.getByRole('link',{name:/已核对/}).isVisible()||!await page.getByRole('link',{name:/全部/}).isVisible())throw Error('Class status filters are missing');
 await page.getByRole('link',{name:/已核对/}).click();await page.getByText('本班没有已核对学生。',{exact:true}).waitFor();
 if(await page.getByRole('link',{name:'查看学生详情'}).count())throw Error('Public progress page exposes student detail links');
 if(await page.getByRole('link',{name:'下载本班名单'}).count())throw Error('Public progress page exposes private export');
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Public progress mobile overflow');
 await page.screenshot({path:path.join(out,'mobile-public-progress.png'),fullPage:true});
 await page.goto(base+'/xueji/progress/benbu/');await page.getByRole('heading',{name:'本部学生总表'}).waitFor();
 if(await page.locator('.class-progress-card').count())throw Error('Head-campus page still groups students by class');
 if(await page.locator('tbody tr').count()!==1)throw Error('Head-campus total table contains the wrong population');
 const parentSession=session();
 await context.addCookies([{name:'xueji_session',value:parentSession,domain:'127.0.0.1',path:'/xueji/'}]);
 const nojs=await browser.newContext({viewport:{width:375,height:812},deviceScaleFactor:3,isMobile:true,hasTouch:true,javaScriptEnabled:false});
 await nojs.addCookies([{name:'xueji_session',value:parentSession,domain:'127.0.0.1',path:'/xueji/'}]);
 const nojsPage=await nojs.newPage();await nojsPage.goto(base+'/xueji/check/1/');
 if(await nojsPage.locator('[data-field="E"] [data-region-province] option').count()!==35)throw Error('Server-rendered province fallback missing');
 if(!await nojsPage.getByRole('button',{name:/使用地区搜索/}).first().isVisible())throw Error('No-JavaScript region fallback missing');
 if(!await nojsPage.getByRole('button',{name:/显示完整号码并修改/}).first().isVisible())throw Error('No-JavaScript sensitive fallback missing');
 await nojs.close();
 for(const width of [320,360,375,390,414,430]){
   await page.setViewportSize({width,height:844});await page.goto(base+'/xueji/check/1/');
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Step overflow at '+width+'px');
 }
 await page.setViewportSize({width:390,height:844});
 for(let i=1;i<=5;i++){
   await page.goto(base+'/xueji/check/'+i+'/');
   if(page.url().includes('result'))throw Error('Demo student already submitted; reopen locally for QA');
   if(i===1){
     await page.locator('[name=result_B][value=unconfirmed]').check();
     await page.getByRole('button',{name:/保存并进入下一步/}).click();
     const firstError=page.locator('[data-first-error]');await firstError.waitFor();
     if(await firstError.getAttribute('data-field')!=='B')throw Error('Validation did not locate the first field');
     await page.waitForTimeout(700);
     const errorBox=await firstError.boundingBox();
     if(!errorBox||errorBox.y<0||errorBox.y>=844)throw Error('First validation error is outside the mobile viewport');
     if(!await page.locator('[data-validation-summary]').isVisible())throw Error('Validation summary missing');
   }
   await page.locator('input[type=radio][value=confirmed]').evaluateAll(els=>els.forEach(e=>e.click()));
   if(i===1){
     const region=page.locator('[data-field="E"] [data-region-picker]');
     if(await region.locator('[data-region-province] option').count()!==35)throw Error('Nationwide province list missing');
     await region.locator('[data-region-province]').selectOption({label:'湖南省'});
     await region.locator('[data-region-city]').selectOption({label:'长沙市'});
     if(await region.locator('[data-region-district] option').allTextContents().then(items=>items.includes('市辖区')))throw Error('Aggregate municipal placeholder exposed');
     await region.locator('[data-region-district]').selectOption({label:'雨花区'});
     if(await region.locator('[data-region-value]').inputValue()!=='湖南省长沙市雨花区')throw Error('Cascading region value mismatch');
     if(!await page.locator('[name=result_E][value=unconfirmed]').isChecked())throw Error('Region change did not require confirmation');
     await page.locator('[name=result_E][value=confirmed]').check();
   }
   if(i===2){await page.locator('[name=result_V][value=unconfirmed]').check();await page.locator('[name=note_V]').fill('演示核实班级');}
   if(i===2){await page.locator('[name=value_AA]').fill('演示新住址 88 号（虚构）');await page.locator('[name=result_AA][value=confirmed]').check();}
   if(i===1){await page.getByText('显示完整号码并修改',{exact:true}).click();await page.locator('[name=value_J]').waitFor();if(await page.locator('[name=value_J]').inputValue()!=='DEMO2026001')throw Error('Sensitive value not loaded');await page.screenshot({path:path.join(out,'mobile-check.png'),fullPage:true});}
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Step overflow '+i);
   await page.getByRole('button',{name:/保存并进入下一步/}).click();
 }
 await page.screenshot({path:path.join(out,'mobile-confirm.png'),fullPage:true});
 if(await canvasReady(page) !== '1')throw Error('Signature script did not initialize');
 const canvas=page.locator('#signature-pad');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
 await page.mouse.move(box.x+40,box.y+box.height/2);await page.mouse.down();
 await page.mouse.move(box.x+180,box.y+box.height/2-20);await page.mouse.move(box.x+280,box.y+box.height/2+10);await page.mouse.up();
 await page.locator('[name=ack]').check();await page.getByRole('button',{name:'确认提交',exact:true}).click();
 await page.getByRole('heading',{name:'学籍信息已提交'}).waitFor();await page.screenshot({path:path.join(out,'mobile-result.png'),fullPage:true});
 await context.addCookies([{name:'xueji_session',value:session(true),domain:'127.0.0.1',path:'/xueji/'}]);
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/xueji/manage/');await page.screenshot({path:path.join(out,'admin-dashboard.png'),fullPage:true});
 await page.getByRole('link',{name:/家长逐项确认与签名/}).waitFor();
 await page.getByRole('link',{name:'按班查看学生核对情况'}).click();await page.getByRole('heading',{name:'按班查看学生核对情况'}).waitFor();
 await page.getByRole('link',{name:'查看学生'}).first().click();await page.locator('#class-pending-list').waitFor();
 if(await page.getByRole('link',{name:'核对工作台'}).count())throw Error('Standalone progress page links to admin dashboard');
 if(await page.getByRole('link',{name:'查看学生详情'}).count())throw Error('Standalone progress page links to private student details');
 await page.screenshot({path:path.join(out,'admin-pending-classes.png'),fullPage:true});
 await page.goto(base+'/xueji/manage/');
 await page.getByRole('link',{name:'查看',exact:true}).first().click();await page.getByRole('heading',{name:'学校维护字段'}).waitFor();
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({passed:true,checks:['mobile login','public class pending list','public privacy boundary','separate head-campus population','server-rendered no-JavaScript fallback','320-430px mobile widths','nationwide cascading regions','5 step direct edit','confirmation states','sensitive edit','readonly issue','address correction','signature submit','admin dashboard','standalone class pending list','no admin links from standalone view','student detail','no horizontal overflow','no JS or HTTP 5xx'],screenshots:7}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

async function canvasReady(page){return page.locator('#signature-pad').getAttribute('data-ready');}


