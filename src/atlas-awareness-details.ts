import type { AtlasAwarenessEvent, AtlasResourceObservation, AtlasResourceRef } from './atlas-awareness.js';

/**
 * Secondary Atlas adapters. Copy only reviewed identity and aggregate fields
 * into UI telemetry. Record payloads, schemas, findings text and file contents
 * are never persisted in a resource event.
 */
export type AtlasDetail =
  | { kind:'project'; projectId:string; label?:string }
  | { kind:'store'; projectId:string; storeId:string; label?:string; fieldCount?:number }
  | { kind:'record'; projectId:string; storeId:string; recordId:string }
  | { kind:'review_overview'; projectId:string; reviewRuns:number; findingObservations:number }
  | { kind:'review_pr'; repository:string; prNumber:number; recordedRounds:number;
      latestReviewHead:'current'|'outdated'|'unknown'|'no_stored_review';
      latest?:{runId:string; verdict:'changes_requested'|'concerns_to_verify'|'non_blocking'|'no_findings'|'inconclusive';
        reviewedAt:string; headSha:string; counts?:SeverityCounts};
      currentHead:{state:'open'|'closed'|'unavailable'; checkedAt?:string} }
  | { kind:'review_findings'; runId:string; total:number; pageCount:number;
      offset:number; counts:SeverityCounts };

export type SeverityCounts={sev1:number;sev2:number;sev3:number;sev4:number};
export interface AtlasDetailView { taskId:string; agentRunId?:string; invocationId?:string;
  observedAt:string; detail:AtlasDetail; resources:AtlasResourceRef[]; }

const UUID=/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const SHA=/^[\da-f]{40}$/i;
const REPO=/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const uuid=(value:unknown):string|undefined=>typeof value==='string'&&UUID.test(value)?value.toLowerCase():undefined;
const object=(value:unknown):Record<string,unknown>|undefined=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const count=(value:unknown):number|undefined=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000?value:undefined;
const label=(value:unknown):string|undefined=>
  typeof value==='string'&&value.length>0&&value.length<=100&&
  !/[\x00-\x1f\x7f-\x9f]/.test(value)?value:undefined;
const repository=(value:unknown):string|undefined=>
  typeof value==='string'&&value.length<=160&&REPO.test(value)&&
  !value.split('/').some(part=>part==='.'||part==='..'||part.includes('..'))?value.toLowerCase():undefined;
const verdicts=new Set(['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive']);
const heads=new Set(['current','outdated','unknown','no_stored_review']);
const reviewProjectId='008b191b-96c2-4a5f-92f6-1f13d6d790d5';
function counts(value:unknown):SeverityCounts|undefined {
  const v=object(value);
  const sev1=count(v?.sev1),sev2=count(v?.sev2),sev3=count(v?.sev3),sev4=count(v?.sev4);
  if([sev1,sev2,sev3,sev4].some(x=>x===undefined))return undefined;
  return {sev1:sev1!,sev2:sev2!,sev3:sev3!,sev4:sev4!};
}
function observed(toolName:string,resources:AtlasResourceRef[],detail:AtlasDetail):AtlasResourceObservation {
  return {schemaVersion:1,providerId:'atlas',toolName,evidenceSource:'response',resources,detail};
}

/** No model-generated payload, nested record data, arbitrary URLs or review prose. */
export function observeAtlasDetailResult(toolName:string,args:Record<string,unknown>,value:unknown):
  AtlasResourceObservation|null {
  const data=object(value);
  if(!data)return null;
  const projectId=uuid(args.projectId),storeId=uuid(args.storeId),recordId=uuid(args.recordId);
  if(toolName==='get_project'){
    if(!projectId||uuid(data.id)!==projectId)return null;
    return observed(toolName,[{type:'project',id:projectId}],
      {kind:'project',projectId,label:label(data.name)});
  }
  if(toolName==='get_store'){
    if(!projectId||!storeId||uuid(data.id)!==storeId||uuid(data.projectId)!==projectId)return null;
    const schema=object(data.schema);
    const fieldCount=Array.isArray(schema?.fields)?Math.min(schema.fields.length,10000):undefined;
    return observed(toolName,[{type:'project',id:projectId},{type:'store',id:storeId}],
      {kind:'store',projectId,storeId,label:label(data.name),fieldCount});
  }
  if(toolName==='get_record'){
    if(!projectId||!storeId||!recordId||uuid(data.id)!==recordId)return null;
    // Some Core versions return bare record objects; enforce any explicitly
    // returned ownership fields, but never persist the record's data.
    if((data.projectId!==undefined&&uuid(data.projectId)!==projectId)||
       (data.storeId!==undefined&&uuid(data.storeId)!==storeId))return null;
    return observed(toolName,[{type:'project',id:projectId},{type:'store',id:storeId},
      {type:'record',id:recordId}],{kind:'record',projectId,storeId,recordId});
  }
  if(toolName==='code_reviews_overview'){
    if(uuid(data.projectId)!==reviewProjectId)return null;
    const reviewRuns=count(data.reviewRuns),findingObservations=count(data.findingObservations);
    if(reviewRuns===undefined||findingObservations===undefined)return null;
    return observed(toolName,[{type:'application',id:'code-reviews'},{type:'project',id:reviewProjectId}],
      {kind:'review_overview',projectId:reviewProjectId,reviewRuns,findingObservations});
  }
  if(toolName==='code_reviews_pr_summary'){
    const requestedRepo=repository(args.repository),suppliedRepo=repository(data.repository);
    const prNumber=count(args.prNumber),returnedPr=count(data.prNumber);
    if(!requestedRepo||requestedRepo!==suppliedRepo||!prNumber||prNumber>1_000_000||returnedPr!==prNumber)return null;
    const recordedRounds=count(data.recordedRounds);
    if(recordedRounds===undefined||!heads.has(String(data.latestReviewHead)))return null;
    const rawLatest=data.latest===null?undefined:object(data.latest);
    if(data.latest!==null&&!rawLatest)return null;
    let latest:Extract<AtlasDetail,{kind:'review_pr'}>['latest'];
    if(rawLatest){
      const runId=uuid(rawLatest.runId),sha=rawLatest.headSha,reviewedAt=rawLatest.reviewedAt;
      if(!runId||typeof sha!=='string'||!SHA.test(sha)||
         typeof reviewedAt!=='string'||!Number.isFinite(Date.parse(reviewedAt))||
         !verdicts.has(String(rawLatest.verdict)))return null;
      latest={runId,headSha:sha.toLowerCase(),reviewedAt,
        verdict:rawLatest.verdict as NonNullable<typeof latest>['verdict'],
        counts:counts(rawLatest.severityCounts)};
    }
    if((recordedRounds===0)!==(!latest))return null;
    const currentHead=object(data.currentHead);
    if(!currentHead||!['open','closed','unavailable'].includes(String(currentHead.state)))return null;
    const checkedAt=currentHead.checkedAt;
    if(checkedAt!==undefined&&(typeof checkedAt!=='string'||!Number.isFinite(Date.parse(checkedAt))))return null;
    const state=currentHead.state as 'open'|'closed'|'unavailable';
    // Atlas's evaluated comparison is the authority; no 'current' claim
    // without an actual verified head and saved review.
    if(data.latestReviewHead==='current'&&(!latest||state==='unavailable'||
      typeof currentHead.sha!=='string'||currentHead.sha.toLowerCase()!==latest.headSha))return null;
    if(data.latestReviewHead==='no_stored_review'&&latest)return null;
    const detail:AtlasDetail={kind:'review_pr',repository:requestedRepo,prNumber,recordedRounds,
      latestReviewHead:data.latestReviewHead as Extract<AtlasDetail,{kind:'review_pr'}>['latestReviewHead'],
      latest,currentHead:{state,checkedAt:typeof checkedAt==='string'?checkedAt:undefined}};
    return observed(toolName,[{type:'application',id:'code-reviews'},
      {type:'pull_request',id:requestedRepo+'#'+prNumber},
      ...(latest?[{type:'record' as const,id:latest.runId}]:[])],detail);
  }
  if(toolName==='code_reviews_list_findings'){
    const runId=uuid(args.reviewRunId),total=count(data.total),offset=count(args.offset??0);
    if(!runId||total===undefined||offset===undefined||!Array.isArray(data.items)||
      data.items.length>100||total<offset+data.items.length)return null;
    const severity:SeverityCounts={sev1:0,sev2:0,sev3:0,sev4:0};
    const ids:string[]=[];
    for(const item of data.items){
      const row=object(item),info=object(row?.data),id=uuid(row?.id);
      const sev=info?.severity;
      if(!id||uuid(info?.reviewRunId)!==runId||
        !['sev1','sev2','sev3','sev4'].includes(String(sev)))return null;
      ids.push(id);severity[sev as keyof SeverityCounts]++;
    }
    const resources:AtlasResourceRef[]=[{type:'application',id:'code-reviews'},
      {type:'record',id:runId},...ids.slice(0,16).map(id=>({type:'finding' as const,id}))];
    return observed(toolName,resources,{kind:'review_findings',runId,total,
      offset,pageCount:data.items.length,counts:severity});
  }
  return null;
}

/** One newest safe detail per (task, kind, resource); replay idempotent. */
export function projectAtlasDetails(events:ReadonlyArray<AtlasAwarenessEvent>):AtlasDetailView[]{
  const map=new Map<string,AtlasDetailView>(),seen=new Set<string>();
  for(const event of [...events].sort((a,b)=>a.sequence-b.sequence)){
    if(seen.has(event.id))continue;
    seen.add(event.id);
    const fact=event.type==='atlas_resource'&&event.state==='completed'?event.atlasResource:undefined;
    if(!event.taskId||fact?.schemaVersion!==1||fact.providerId!=='atlas'||!fact.detail)continue;
    const d=fact.detail;
    const id=d.kind==='project'?d.projectId:d.kind==='store'?d.storeId:
      d.kind==='record'?d.recordId:d.kind==='review_overview'?d.projectId:
      d.kind==='review_pr'?d.repository+'#'+d.prNumber:d.runId+':'+d.offset;
    map.set(event.taskId+':'+d.kind+':'+id,{taskId:event.taskId,
      agentRunId:event.agentRunId??undefined,invocationId:event.invocationId??undefined,
      observedAt:event.timestamp,detail:d,resources:fact.resources});
  }
  return [...map.values()].slice(-32);
}

/** A verified GitHub route constructed exclusively from validated PR identity. */
export function reviewPullRequestUrl(detail:AtlasDetail):string|undefined {
  if(detail.kind!=='review_pr'||!repository(detail.repository)||
    !Number.isSafeInteger(detail.prNumber)||detail.prNumber<1||detail.prNumber>1_000_000)return undefined;
  const [owner,repo]=detail.repository.split('/');
  return 'https://github.com/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo)+
    '/pull/'+detail.prNumber;
}
