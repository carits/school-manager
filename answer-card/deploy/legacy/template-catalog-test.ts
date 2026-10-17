import assert from "node:assert/strict";
import {pdfTemplateVersions} from "../../src/shared/pdfTemplateVersions.ts";
const rows=[{id:"a1",family_id:"a",revision:1,status:"published"},{id:"a2",family_id:"a",revision:2,status:"published",archived_at:"2026-10-13"},{id:"b",family_id:"b",revision:1,status:"published"},{id:"old",family_id:"old",revision:1,status:"draft",archived_at:"2026-10-13"}];
const x=pdfTemplateVersions(rows);assert.deepEqual(x.current.map(t=>t.id),["a1","b"]);assert.equal(x.published.length,2);assert.equal(x.history.length,2);assert.equal(x.drafts.length,0);assert.equal(rows.length,4);
const draft=pdfTemplateVersions([...rows,{id:"c",revision:1,status:"draft"}]);assert.equal(draft.current.length,3);assert.equal(draft.published.length,2);assert.equal(draft.drafts.length,1);
console.log(JSON.stringify({currentCards:2,publishedCards:2,historyRecords:2,historyNotCountedAsCards:true,draftCountSeparate:true,noRecordsChanged:true}));
