import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { WEEK7_CHINESE_TEMPLATE as template } from '../src/shared/externalPaperPreset';
import { makeExternalFixture } from './external-paper-fixture';
const exec=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),'external-native-'));
process.env.ANSWER_CARD_DATA_DIR=path.join(root,'data');
const {renderPage,recognizeExternal}=await import('../src/server/services/externalPaper/files');
const exe=process.env.ANSWER_CARD_RECOGNIZER_EXE;
if(!exe)throw new Error('Set ANSWER_CARD_RECOGNIZER_EXE to the freshly built binary; native tests must not silently skip.');
await access(exe);let count=0;
try {
 const blank=path.join(root,'blank.pdf'),filled=path.join(root,'filled.pdf');
 await makeExternalFixture(blank,template);await makeExternalFixture(filled,template,{filled:true,studentNumber:'001234'});
 const referencePaths=[];for(const p of template.pages)referencePaths.push(await renderPage(blank,p.number,path.join(root,`ref-${p.number}`)));
 const runtime=path.join(root,'runtime.json');await writeFile(runtime,JSON.stringify({...template,pages:template.pages.map(p=>({...p,referencePath:referencePaths[p.number-1]}))}));
 const source=[];for(const p of template.pages)source.push(await renderPage(filled,p.number,path.join(root,`filled-${p.number}`)));
 for(const angle of [0,90,180,270]) for(const n of [1,2]) {
  const image=path.join(root,`p${n}-${angle}.png`);await sharp(source[n-1]).rotate(angle).png().toFile(image);
  const r=await recognizeExternal(image,runtime,path.join(root,`result-${n}-${angle}`));
  assert.equal(r.status,'ok',JSON.stringify(r));assert.equal(r.pageNumber,n);
  if(n===1){assert.equal(r.studentNumber,'001234');assert.equal(r.identityCertain,true);assert.equal(r.questions.length,10);for(const q of r.questions){assert.equal(q.status,'clear',JSON.stringify(q));assert.deepEqual(q.selectedOptions,q.questionNumber===8?['A','B']:['A']);}assert.equal(r.crops.length,8);}
  else {assert.equal(r.crops.length,1);assert.equal(r.crops[0].questionNumber,19);assert.ok(r.crops[0].height>r.crops[0].width);}
  console.log(`PASS native page ${n} rotation ${angle}, confidence=${r.quality}`);count++;
 }
 const r=await recognizeExternal(referencePaths[0],runtime,path.join(root,'blank-result'));assert.equal(r.status,'ok');assert.equal(r.identityCertain,false);assert.ok(r.questions.every(q=>q.status==='blank'&&q.selectedOptions.length===0));count++;console.log('PASS native blank page is not a guessed student');
 const cut=path.join(root,'cut.png');const meta=await sharp(source[0]).metadata();await sharp(source[0]).extract({left:170,top:0,width:meta.width!-170,height:meta.height!}).png().toFile(cut);
 const rejected=await recognizeExternal(cut,runtime,path.join(root,'cut-result'));assert.equal(rejected.status,'failed');count++;console.log('PASS native missing corner rejected, not graded as blank');
 const tilted=path.join(root,'tilted.jpg');await sharp(source[0]).rotate(1.2,{background:'white'}).jpeg({quality:85}).toFile(tilted);
 const corrected=await recognizeExternal(tilted,runtime,path.join(root,'tilted-result'));assert.equal(corrected.status,'ok',JSON.stringify(corrected));assert.equal(corrected.studentNumber,'001234');assert.ok(corrected.questions.every(q=>q.status==='clear'));count++;console.log('PASS native tilt and JPEG compression');
 console.log(`${count} native external-paper checks passed`);
}finally{await rm(root,{recursive:true,force:true});}
