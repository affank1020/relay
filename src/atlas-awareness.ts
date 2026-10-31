/**
 * Atlas-only observation adapter. Every persisted value is extracted from a
 * known, structured MCP result, never from model output or raw text content.
 * This is additive to Relay's provider-neutral invocation event stream.
 */
export type AtlasResourceType =
  'project'|'logical_workspace'|'checkout'|'worktree'|'node'|'repository'|
  'branch'|'pull_request'|'store'|'record'|'application'|'file'|'finding';
export interface AtlasResourceRef { type: AtlasResourceType; id: string; }
export interface AtlasCheckoutFact {
  id:string; name?:string; logicalWorkspaceId?:string; projectId?:string;
  rootPath?:string; nodeId?:string; status?:'active'|'archived';
}
export interface AtlasNodeFact { id:string; name?:string; status?:'online'|'offline'; }
export interface AtlasGitFact {
  checkoutId:string; branch?:string; repository?:string; dirty?:boolean;
  changedFiles?:number; changedFilesTruncated?:boolean; available:true;
}
export interface AtlasWorktreeFact { id:string; rootPath:string; branch?:string; head?:string; }
export interface AtlasResourceObservation {
  schemaVersion:1;
  providerId:'atlas';
  toolName:string;
  evidenceSource:'response'|'resolved';
  resources:AtlasResourceRef[];
  checkout?:AtlasCheckoutFact;
  node?:AtlasNodeFact;
  git?:AtlasGitFact;
  worktrees?:AtlasWorktreeFact[];
}
export interface AtlasAwarenessEvent {
  id:string; sequence:number; timestamp:string; conversationId:string;
  taskId:string|null; agentRunId:string|null; invocationId:string|null;
  type:string; state:string; tool:string|null; workspaceId:string|null;
  atlasResource?:AtlasResourceObservation;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid=(v:unknown):string|undefined=>typeof v==='string'&&UUID.test(v)?v.toLowerCase():undefined;
const record=(v:unknown):Record<string,unknown>|undefined=>
  v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const safe=(v:unknown,max=140):string|undefined=>
  typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v)?v:undefined;
const path=(v:unknown):string|undefined=>{
  const s=safe(v,400);
  return s&&s.startsWith('/')&&!s.includes('\\')&&!s.includes('://')&&!s.includes('/../')?s:undefined;
};
const repository=(v:unknown):string|undefined=>{
  const s=safe(v,160);
  return s&&/^[\w.-]+\/[\w.-]+$/.test(s)&&!s.includes('..')?s:undefined;
};
const branch=(v:unknown):string|undefined=>{
  const s=safe(v,160);
  return s&&/^[\w./-]+$/.test(s)&&!s.includes('..')&&!s.startsWith('/')?s:undefined;
};

/** Interpret ONLY reviewed Atlas contracts, and only a successful structured response. */
export function observeAtlasResult(
  toolName:string, args:Record<string,unknown>, value:unknown,
  resolvedCheckout?:AtlasCheckoutFact
):AtlasResourceObservation|null {
  const data=record(value);
  if(!data)return null;
  const checkoutId=uuid(args.checkoutId??args.workspaceId);
  const id=uuid(data.id);
  const base={schemaVersion:1 as const,providerId:'atlas' as const,toolName,
    evidenceSource:'response' as const};
  if(toolName==='get_workspace'){
    if(!checkoutId||id!==checkoutId)return null;
    const nodeId=uuid(data.nodeId);
    const status=data.status==='active'||data.status==='archived'?data.status:undefined;
    const checkout:AtlasCheckoutFact={id,name:safe(data.name),nodeId,
      logicalWorkspaceId:uuid(data.logicalWorkspaceId),projectId:uuid(data.projectId),
      rootPath:path(data.rootPath),status};
    const resources:AtlasResourceRef[]=[{type:'checkout',id}];
    if(nodeId)resources.push({type:'node',id:nodeId});
    if(checkout.logicalWorkspaceId)resources.push({type:'logical_workspace',id:checkout.logicalWorkspaceId});
    if(checkout.projectId)resources.push({type:'project',id:checkout.projectId});
    return {...base,resources,checkout};
  }
  if(toolName==='get_node'){
    const nodeId=uuid(args.nodeId);
    const details=record(data.node)??data;
    if(!nodeId||uuid(details.id)!==nodeId)return null;
    const status=details.status==='online'||details.status==='offline'?details.status:undefined;
    return {...base,resources:[{type:'node',id:nodeId}],node:{id:nodeId,name:safe(details.name),status}};
  }
  if(toolName==='workspace_git_status'){
    // The successful, checkout-scoped Atlas tool receipt is the authority for
    // Git state. Preflight placement alone does NOT establish Git execution.
    if(!checkoutId||resolvedCheckout?.id!==checkoutId||data.available!==true)return null;
    const git:AtlasGitFact={checkoutId,available:true,branch:branch(data.branch),
      repository:repository(data.originRepository),dirty:typeof data.dirty==='boolean'?data.dirty:undefined,
      changedFiles:Array.isArray(data.changes)?Math.min(data.changes.length,2000):undefined,
      changedFilesTruncated:data.truncated===true||
        (Array.isArray(data.changes)&&data.changes.length>2000)};
    const resources:AtlasResourceRef[]=[{type:'checkout',id:checkoutId}];
    if(git.repository)resources.push({type:'repository',id:git.repository});
    if(git.repository&&git.branch)resources.push({type:'branch',id:git.repository+':'+git.branch});
    return {...base,resources,git};
  }
  if(toolName==='workspace_git_list_worktrees'){
    if(!checkoutId||resolvedCheckout?.id!==checkoutId||!Array.isArray(data.worktrees))return null;
    const worktrees:AtlasWorktreeFact[]=[];
    for(const item of data.worktrees.slice(0,16)){
      const tree=record(item),rootPath=path(tree?.rootPath);
      if(!rootPath)continue;
      const nodeId=resolvedCheckout.nodeId;
      if(!nodeId)continue;
      worktrees.push({id:nodeId+':'+rootPath,rootPath,branch:branch(tree?.branch),head:typeof tree?.head==='string'&&/^[a-f\d]{40}$/i.test(tree.head)?tree.head:undefined});
    }
    return {...base,resources:[{type:'checkout',id:checkoutId},...worktrees.map(t=>({type:'worktree' as const,id:t.id}))],worktrees};
  }
  return null;
}

export interface AtlasCheckoutView {
  checkoutId:string; name?:string; rootPath?:string; logicalWorkspaceId?:string;
  projectId?:string; nodeId?:string; nodeName?:string; nodeStatus?:string;
  placementStatus?:string; branch?:string; repository?:string; dirty?:boolean;
  changedFiles?:number; changedFilesTruncated?:boolean; gitObservedAt?:string;
  placementObservedAt?:string; placementSupersededAt?:string;
  nodeObservedAt?:string; agentRunId?:string; taskId:string;
  lastFailureAt?:string; lastFailureState?:string;
  lastFailureTool?:'workspace_git_status'|'workspace_git_list_worktrees';
  worktrees?:AtlasWorktreeFact[];
}
/**
 * Pure replay projection. Resource state is *per originating task*, not one
 * conversation-wide checkout card: a later task must not steal or inherit a
 * previous task's Git or Node observation. Cross-task placement reads are
 * considered only to flag an older snapshot as superseded.
 */
export function projectAtlasCheckouts(events:ReadonlyArray<AtlasAwarenessEvent>):AtlasCheckoutView[] {
  const observed=new Set<string>();
  const checkouts=new Map<string,AtlasCheckoutView>();
  const nodes=new Map<string,{fact:AtlasNodeFact;at:string}>();
  const latestPlacements=new Map<string,{fact:AtlasCheckoutFact;at:string}>();
  const ordered=[...events].sort((a,b)=>a.sequence-b.sequence);
  for(const event of ordered){
    if(observed.has(event.id))continue;
    observed.add(event.id);
    const fact=event.type==='atlas_resource'&&event.state==='completed'?event.atlasResource:undefined;
    if(fact?.schemaVersion===1&&fact.providerId==='atlas'){
      if(fact.checkout)latestPlacements.set(fact.checkout.id,{fact:fact.checkout,at:event.timestamp});
      if(!event.taskId)continue;
      if(fact.node)nodes.set(event.taskId+':'+fact.node.id,{fact:fact.node,at:event.timestamp});
      const id=fact.checkout?.id??fact.git?.checkoutId??
        (fact.worktrees?event.workspaceId:undefined);
      if(!id)continue;
      const key=event.taskId+':'+id;
      let view=checkouts.get(key);
      if(!view){view={checkoutId:id,taskId:event.taskId};checkouts.set(key,view);}
      if(fact.checkout){
        const c=fact.checkout;
        // Physical placement changes invalidate Git reads within this task.
        if((view.nodeId&&view.nodeId!==c.nodeId)||
           (view.rootPath&&view.rootPath!==c.rootPath)||c.status==='archived'){
          view.branch=undefined;view.repository=undefined;view.dirty=undefined;
          view.changedFiles=undefined;view.changedFilesTruncated=undefined;
          view.gitObservedAt=undefined;view.worktrees=undefined;
        }
        view.name=c.name;view.rootPath=c.rootPath;view.nodeId=c.nodeId;
        view.logicalWorkspaceId=c.logicalWorkspaceId;view.projectId=c.projectId;
        view.placementStatus=c.status;view.placementObservedAt=event.timestamp;
      }
      if(fact.git){
        view.branch=fact.git.branch;view.repository=fact.git.repository;
        view.dirty=fact.git.dirty;view.changedFiles=fact.git.changedFiles;
        view.changedFilesTruncated=fact.git.changedFilesTruncated;
        view.gitObservedAt=event.timestamp;
      }
      if(fact.worktrees)view.worktrees=fact.worktrees;
      if(event.agentRunId)view.agentRunId=event.agentRunId;
    } else if(event.type==='tool'&&event.taskId&&
      (event.tool==='workspace_git_status'||event.tool==='workspace_git_list_worktrees')&&
      ['failed','denied','cancelled'].includes(event.state)&&event.workspaceId){
      const view=checkouts.get(event.taskId+':'+event.workspaceId);
      if(view){
        view.lastFailureAt=event.timestamp;view.lastFailureState=event.state;
        view.lastFailureTool=event.tool;
      }
    }
  }
  return [...checkouts.values()].slice(-32).map(view=>{
    const node=view.nodeId?nodes.get(view.taskId+':'+view.nodeId):undefined;
    const latest=latestPlacements.get(view.checkoutId);
    const laterPlacement=latest && (
      (view.nodeId&&latest.fact.nodeId&&view.nodeId!==latest.fact.nodeId)||
      (view.rootPath&&latest.fact.rootPath&&view.rootPath!==latest.fact.rootPath)||
      (latest.fact.status==='archived'&&view.placementStatus!=='archived')
    );
    return {...view,nodeName:node?.fact.name,nodeStatus:node?.fact.status,
      nodeObservedAt:node?.at,placementSupersededAt:laterPlacement?latest.at:undefined};
  });
}
