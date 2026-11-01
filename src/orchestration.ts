import type { Task, Usage } from './store.js';
type AgentProfileId='general'|'researcher'|'reviewer'|'implementer';

// Provider-neutral snapshot. Future Skills/MCP providers can contribute admitted
// names, but only the server's tool registry may enforce/expand that admission.
export interface DelegationSnapshot {
  schemaVersion: 1;
  toolNames: string[];
  modelKey: string | null;
  context: string;
  maxTokens: number | null;
  maxCostUsd: number | null;
  /** Optional on legacy tasks; role is output guidance, never tool authority. */
  profile?: AgentProfileId;
}

export function validateDependencies(tasks:Task[], conversationId:string, ids:string[], parentId:string|null):void {
  if(!Array.isArray(ids)||ids.length>8||new Set(ids).size!==ids.length || ids.some(id=>typeof id!=='string'))
    throw new Error('Invalid dependencies');
  for(const id of ids) {
    const dep=tasks.find(task=>task.id===id);
    // A delegated task can only consume explicitly named sibling results.
    // A user task can only depend on work from its own conversation.
    if(!dep || dep.kind==='join' || (parentId ? dep.parentId!==parentId : dep.conversationId!==conversationId))
      throw new Error('Invalid dependencies: cross-scope reference');
  }
  // All edges point to already persisted tasks; no future/self edges exist.
}

export function used(usage:readonly Usage[]) {
  return {tokens:usage.reduce((n,u)=>n+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),0),
    usd:usage.reduce((n,u)=>n+(u.costUsd??0),0),
    unknown:usage.some(u=>u.input===null||u.output===null||u.costUsd===null)};
}
// Resolve the billing family of a task, including internal synthesis runs.
// Other root turns in the same conversation share the same session budget.
// Parent/continuation chains are persisted, and missing ancestors fail closed.
export function originatingConversation(task:Task, byId:Map<string,Task>):string {
  const seen=new Set<string>();
  let current=task;
  while(current.parentId || current.continuationOf) {
    if(seen.has(current.id))throw new Error('Invalid task ancestry');
    seen.add(current.id);
    const ancestor=byId.get(current.parentId??current.continuationOf!);
    if(!ancestor)throw new Error('Missing task parent');
    current=ancestor;
  }
  return current.conversationId;
}
export interface DependencyReceipt {
  taskId:string;
  result:string;
}

// Retry receipts are immutable snapshots from completed dependencies.
// They are data, never a substitute for tool receipts, and must be bounded.
export function completedDependencyReceipts(task:Task, byId:Map<string,Task>):DependencyReceipt[] {
  if(task.retryDependencyResults)return task.retryDependencyResults;
  if(task.dependencies.length>8)throw new Error('Invalid retry dependencies');
  return task.dependencies.map(id=>{
    const source=byId.get(id);
    if(!source || source.state!=='completed')
      throw new Error('Retry dependencies are incomplete or unavailable; reconcile before retrying');
    return {taskId:id,result:source.result.slice(0,12000)};
  });
}
