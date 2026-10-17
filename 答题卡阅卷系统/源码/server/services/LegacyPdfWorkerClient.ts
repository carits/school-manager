import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createInterface} from "node:readline";
type Row=Record<string,any>;
let child:ChildProcessWithoutNullStreams|null=null,tail:Promise<any>=Promise.resolve(),active:{resolve:(v:any)=>void;reject:(e:any)=>void;id:number}|null=null,serial=0;
function stop(error:Error){const current=child;child=null;const a=active;active=null;a?.reject(error);current?.kill("SIGKILL");}
function start(script:string){
 if(child)return child;
 const proc=spawn("python3",[script,"--serve"],{stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONUNBUFFERED:"1"}});child=proc;
 createInterface({input:proc.stdout}).on("line",line=>{
  if(child!==proc)return;
  try{const r=JSON.parse(line);if(!active||r.id!==active.id)throw new Error("识别进程响应编号异常");const a=active;active=null;r.error?a.reject(new Error(r.error)):a.resolve(r.result);}
  catch(e:any){stop(e);}
 });
 proc.stderr.on("data",d=>console.error("[Legacy worker]",String(d).slice(0,800)));
 proc.on("error",e=>{if(child===proc)stop(e);});
 proc.on("exit",()=>{if(child===proc)stop(new Error("识别进程退出，任务可重试"));});return proc;
}
process.once("exit",()=>child?.kill());
export function callLegacyWorker(script:string,request:Row,protect:()=>Promise<void>):Promise<Row>{
 const operation=tail.catch(()=>{}).then(async()=>{
  await protect();const proc=start(script),id=++serial;
  let timer:ReturnType<typeof setTimeout>|undefined,guard:ReturnType<typeof setInterval>|undefined;
  try{return await new Promise<Row>((resolve,reject)=>{
   active={resolve,reject,id};
   timer=setTimeout(()=>stop(new Error("识别页面处理超时，任务可重试")),90000);
   guard=setInterval(()=>{void protect().catch(e=>stop(Object.assign(e,{status:e.status||503})));},5000);
   proc.stdin.write(JSON.stringify({id,request})+"\n",e=>{if(e&&child===proc)stop(e);});
  });}finally{if(timer)clearTimeout(timer);if(guard)clearInterval(guard);}
 });tail=operation;return operation;
}
