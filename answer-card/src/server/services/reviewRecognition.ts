import sharp from "sharp";

export type ReviewRecognitionProfile = {
  identity?: { columns?: number; rows?: number; x0?: number; y0?: number; xStep?: number; yStep?: number; cellWidth?: number; cellHeight?: number; threshold?: number };
  objective?: { questions?: Array<{ number: number; options: string[]; centers: Array<{x:number;y:number}>; radius?: number }>; threshold?: number };
};
export type IdentityRecognition = { studentNumber: string|null; confidence:number; status:"recognized"|"unrecognized"; source:"omr"; columns:Array<{digit:number|null;confidence:number;scores:number[]}> };
export type ObjectiveRecognition = { questions:Array<{number:number;selectedOptions:string[];confidence:number;status:"recognized"|"blank"|"multiple"|"ambiguous";optionScores:Record<string,number>}>; status:"recognized"|"partial"|"failed" };

const dIdentity = {columns:6,rows:10,x0:.515,y0:.395,xStep:.06875,yStep:.055,cellWidth:.045,cellHeight:.039,threshold:.075};
// Layout for the split 01_客观题.jpg (1029x213 proportion). The previous
// coordinates were for a different crop and caused nearly every option to be
// treated as selected. Keep the profile overridable for future card revisions.
const dObjective = {threshold:.30,questions:[
  ...[1,2,3,4,5].map((number,row)=>({number,options:["A","B","C","D"],centers:["A","B","C","D"].map((_x,col)=>({x:.098+col*.054,y:.295+row*.126}))})),
  {number:8,options:["A","B","C","D","E"],centers:["A","B","C","D","E"].map((_x,col)=>({x:.238+col*.054,y:.295}))},
  ...[{number:11,y:.295},{number:13,y:.43},{number:14,y:.56},{number:17,y:.69}].map(({number,y})=>({number,options:["A","B","C","D"],centers:["A","B","C","D"].map((_x,col)=>({x:.477+col*.054,y}))}))
]};
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
function profile(p?:ReviewRecognitionProfile){return {identity:{...dIdentity,...(p?.identity??{})},objective:{...dObjective,...(p?.objective??{})}};}
async function matrix(filePath:string){return sharp(filePath).greyscale().raw().toBuffer({resolveWithObject:true});}
function darkness(data:Buffer,info:{width:number;height:number},x:number,y:number,w:number,h:number){const x0=Math.max(0,Math.floor(x*info.width)),y0=Math.max(0,Math.floor(y*info.height)),x1=Math.min(info.width,Math.max(x0+1,Math.ceil((x+w)*info.width))),y1=Math.min(info.height,Math.max(y0+1,Math.ceil((y+h)*info.height)));let dark=0,total=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){if(data[yy*info.width+xx]<145)dark++;total++;}return total?dark/total:0;}
export async function recognizeIdentityOmr(filePath:string,p?:ReviewRecognitionProfile):Promise<IdentityRecognition>{const {data,info}=await matrix(filePath),q=profile(p).identity;const columns=[];let value="",ok=true;for(let col=0;col<q.columns;col++){const scores=[];for(let row=0;row<q.rows;row++){const x=q.x0+col*q.xStep,y=q.y0+row*q.yStep;scores.push(darkness(data,info,x+(q.cellWidth-q.cellWidth*.62)/2,y+(q.cellHeight-q.cellHeight*.62)/2,q.cellWidth*.62,q.cellHeight*.62));}const ranked=scores.map((score,digit)=>({score,digit})).sort((a,b)=>b.score-a.score),best=ranked[0],second=ranked[1]??{score:0},confidence=clamp((best.score-q.threshold)/.16)*.7+clamp((best.score-second.score)/.08)*.3,digit=best.score>=q.threshold&&confidence>=.55?best.digit:null;if(digit==null)ok=false;else value+=String(digit);columns.push({digit,confidence,scores});}return {studentNumber:ok?value:null,confidence:columns.reduce((s,c)=>s+c.confidence,0)/columns.length,status:ok?"recognized":"unrecognized",source:"omr",columns};}
export async function recognizeObjectiveOmr(filePath:string,p?:ReviewRecognitionProfile):Promise<ObjectiveRecognition>{const {data,info}=await matrix(filePath),q=profile(p).objective,questions=[];for(const item of q.questions??[]){const r=(item as any).radius??.016,optionScores:Record<string,number>={};for(let i=0;i<item.options.length;i++){const c=item.centers[i];optionScores[item.options[i]]=darkness(data,info,c.x-r,c.y-r,r*2,r*2);}const ranked=Object.entries(optionScores).sort((a,b)=>b[1]-a[1]),selected=ranked.filter(([,s])=>s>=(q.threshold??.075)),top=ranked[0]?.[1]??0,next=ranked[1]?.[1]??0;questions.push({number:item.number,selectedOptions:selected.map(([x])=>x),confidence:clamp((top-next)/.12),status:(selected.length===0?"blank":selected.length>1?"multiple":"recognized") as "blank"|"multiple"|"recognized",optionScores});}return {questions,status:questions.every(x=>x.status==="recognized")?"recognized":questions.some(x=>x.status!=="blank")?"partial":"failed"};}
export function defaultReviewRecognitionProfile():ReviewRecognitionProfile{return {identity:{...dIdentity},objective:{threshold:dObjective.threshold,questions:dObjective.questions}};}
