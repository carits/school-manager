import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import type { ExternalTemplate, PaperRect } from "../src/shared/externalPaper";
/** Synthetic test paper, not an actual student's work or the copyrighted source PDF. */
export async function makeExternalFixture(file: string, t: ExternalTemplate, opts: { filled?: boolean; studentNumber?: string; pages?: number[] } = {}): Promise<void> {
  const doc = new PDFDocument({ autoFirstPage: false, compress: false }), stream = createWriteStream(file);
  const done = new Promise<void>((resolve, reject) => { stream.on("finish", resolve); stream.on("error", reject); doc.on("error", reject); }); doc.pipe(stream);
  for (const number of opts.pages ?? t.pages.map(p => p.number)) {
    const p = t.pages[number - 1], w = p.widthPt, h = p.heightPt; doc.addPage({ size: [w,h], margin: 0 });
    const xy = (r: PaperRect): [number,number,number,number] => [r.x*w, r.y*h, r.width*w, r.height*h];
    for (const a of p.anchors) doc.rect(a.x*w-6,a.y*h-6,12,12).fill("black");
    p.verificationRects.forEach((r,i) => { const [x,y,rw,rh] = xy(r); doc.save().rect(x,y,rw,rh).clip(); doc.fillColor("black").fontSize(Math.min(12,rh*.5)); for(let k=0;k<3;k++) doc.text(`PAPER ${number} AREA ${i} - ${number === 1 ? 'EXAMINATION ID FIRST PAGE' : 'ESSAY SECOND PAGE NO ID'} ${k}`, x+2,y+2+k*13,{width:rw-4,height:rh, lineBreak:false}); doc.restore(); });
    const cell = (r:PaperRect, text:string, fill:boolean) => {
      const [x,y,rw,rh]=xy(r);doc.lineWidth(.25).rect(x+.2,y+.2,rw-.4,rh-.4).stroke();
      doc.fontSize(Math.min(5,rh*.65)).text(text,x+rw*.4,y+rh*.2,{width:rw*.5,height:rh*.75,lineBreak:false});
      if(fill) doc.rect(x+rw*.12,y+rh*.13,rw*.76,rh*.74).fill("black");
    };
    if(t.identity.page===number) for(const c of t.identity.cells) cell(c.rect,c.value,!!opts.filled&&c.value===(opts.studentNumber??"001234")[c.column-1]);
    for(const q of t.questions) {
      if(q.type==='objective') q.options!.filter(o=>o.page===number).forEach((o,i)=>cell(o.rect,o.label,!!opts.filled&&i<q.requiredSelections!));
      else for(const r of q.regions!.filter(r=>r.page===number)) {const [x,y,rw,rh]=xy(r.rect);doc.lineWidth(.4).rect(x,y,rw,rh).stroke();doc.fontSize(8).text(`Question ${q.number}`,x+2,y+2);if(opts.filled)doc.fontSize(13).text(`Synthetic answer for question ${q.number}`,x+12,y+20,{width:rw-24,height:Math.max(15,rh-22)});}
    }
  }
  doc.end(); await done;
}
