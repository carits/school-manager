type Template={id:string;family_id?:string;revision:number;status:string;archived_at?:string|null};
export function pdfTemplateVersions<T extends Template>(templates:T[]){
 const latest=new Map<string,T>();
 for(const t of templates){if(t.archived_at)continue;const family=t.family_id||t.id,old=latest.get(family);if(!old||t.revision>old.revision)latest.set(family,t);}
 const ids=new Set([...latest.values()].map(t=>t.id)),current=templates.filter(t=>ids.has(t.id));
 return {current,history:templates.filter(t=>!ids.has(t.id)),published:current.filter(t=>t.status==="published"),drafts:current.filter(t=>t.status==="draft")};
}
