// Model-generated handoffs are never authoritative tool receipts. A strict,
// bounded projection prevents untrusted child text expanding parent context.
export interface HandoffReference { label:string; url?:string }
export interface AgentHandoff {
  schemaVersion:1;
  provenance:'agent_reported';
  structured:boolean;
  summary:string;
  evidence:HandoffReference[];
  artifacts:HandoffReference[];
  openQuestions:string[];
}
const bound=(value:unknown,max:number):string|null=>
  typeof value==='string'&&value.trim().length>0&&value.length<=max?value.trim():null;
const safeUrl=(value:unknown):string|null=>{
  if(typeof value!=='string'||value.length>1000)return null;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!!url.hostname?
      url.toString():null;
  }catch{return null;}
};
function references(value:unknown):HandoffReference[]|null {
  if(!Array.isArray(value)||value.length>6)return null;
  const result:HandoffReference[]=[];
  for(const item of value) {
    if(!item||typeof item!=='object'||Array.isArray(item))return null;
    const data=item as Record<string,unknown>,label=bound(data.label,160);
    if(!label)return null;
    const url=data.url===undefined?undefined:safeUrl(data.url);
    if(data.url!==undefined&&!url)return null;
    result.push({label,...(url?{url}:{})});
  }
  return result;
}
export function agentHandoff(result:string):AgentHandoff {
  const fallback=():AgentHandoff=>({schemaVersion:1,provenance:'agent_reported',
    structured:false,summary:result.slice(0,2000),evidence:[],artifacts:[],openQuestions:[]});
  if(result.length>16000)return fallback();
  let parsed:unknown;
  try{parsed=JSON.parse(result);}catch{return fallback();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fallback();
  const body=(parsed as Record<string,unknown>).relayHandoff;
  if(!body||typeof body!=='object'||Array.isArray(body))return fallback();
  const data=body as Record<string,unknown>;
  const summary=bound(data.summary,2000),evidence=references(data.evidence??[]),
    artifacts=references(data.artifacts??[]),rawQuestions=data.openQuestions??[];
  if(!summary||!evidence||!artifacts||!Array.isArray(rawQuestions)||rawQuestions.length>6)
    return fallback();
  const openQuestions=rawQuestions.map(q=>bound(q,300));
  if(openQuestions.some(q=>q===null))return fallback();
  return {schemaVersion:1,provenance:'agent_reported',structured:true,summary,
    evidence,artifacts,openQuestions:openQuestions as string[]};
}
