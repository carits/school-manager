import type {PdfTemplate} from "./legacyPdf";
export function legacyConfirmationIssues(def:PdfTemplate,student:string,answers:Record<string,unknown>):string[]{
 const issues:string[]=[];
 if(!student||!Number.isInteger(Number(student))||Number(student)<=0)issues.push("请先绑定应考学生。");
 for(const q of def.questions.filter(q=>q.gradingType==="objective")){
  const value=answers[q.questionId];
  if(!Array.isArray(value)||value.some(v=>!q.options?.some(o=>o.label===v))||new Set(value).size!==value.length)
   issues.push("第"+q.displayNumber+"题选项无效，请重新选择。");
 }
 return issues;
}
