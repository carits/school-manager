import type {ExamPdfProgress} from "./examPdfProgress";
export function createExamProgressReader(loader:(ids:number[])=>Promise<ExamPdfProgress[]>,ttl=5000,now=()=>Date.now()){
 const cache=new Map<number,{expires:number;value:ExamPdfProgress}>(),pending=new Map<number,Promise<ExamPdfProgress>>();
 return async(ids:number[])=>{
  const unique=[...new Set(ids)];
  const missing=unique.filter(id=>!pending.has(id)&&(!cache.has(id)||cache.get(id)!.expires<=now()));
  if(missing.length){
   const query=loader(missing);
   for(const id of missing){
    const task=query.then(rows=>{const value=rows.find(r=>r.examId===id);if(!value)throw new Error("考试进度返回不完整");cache.set(id,{expires:now()+ttl,value});return value;}).finally(()=>pending.delete(id));
    pending.set(id,task);
   }
  }
  if(cache.size>500)for(const [id,c] of cache)if(c.expires<=now()&&!pending.has(id))cache.delete(id);
  return Promise.all(unique.map(id=>pending.get(id)||Promise.resolve(cache.get(id)!.value)));
 };
}
