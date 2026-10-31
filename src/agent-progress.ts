import type { State, Task } from './store.js';

export interface AgentProgress {
  id:string;
  parentId:string;
  agentRunId:string|null;
  depth:number;
  role:'general'|'researcher'|'reviewer'|'implementer';
  prompt:string;
  state:State;
  dependencies:string[];
  modelKey:string|null;
  tokens:number|null;
  costUsd:number|null;
  /** Model-authored report, never an authoritative tool receipt. */
  reportedSummary:string|null;
  lastTool:{name:string;state:string}|null;
}

/** Project only descendants of visible root turns. Never expose hidden
 * child conversations, raw transcripts, tool arguments or approval payloads.
 * State and run attribution come from persisted tasks, not model narration.
 */
export function projectAgentProgress(
  roots:readonly Task[], tasks:readonly Task[],
  latestTool:(task:Task)=>AgentProgress['lastTool']=()=>null
):Record<string,AgentProgress[]> {
  const byParent=new Map<string,Task[]>();
  for(const task of tasks) {
    if(!task.parentId||task.kind==='join')continue;
    const children=byParent.get(task.parentId)??[];
    children.push(task);
    byParent.set(task.parentId,children);
  }
  for(const children of byParent.values())
    children.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const answer:Record<string,AgentProgress[]>={};
  for(const root of roots) {
    if(root.parentId||root.kind==='join')continue;
    const result:AgentProgress[]=[];
    const seen=new Set([root.id]);
    const walk=(parentId:string,depth:number)=>{
      if(depth>2||result.length>=20)return;
      for(const child of byParent.get(parentId)??[]) {
        if(result.length>=20||seen.has(child.id))break;
        seen.add(child.id);
        const tokens=child.usage.some(u=>u.input===null||u.output===null)?null:
          child.usage.reduce((n,u)=>n+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),0);
        const costUsd=child.usage.some(u=>u.costUsd===null)?null:
          child.usage.reduce((n,u)=>n+(u.costUsd??0),0);
        result.push({
          id:child.id,parentId,agentRunId:child.agentRunId??null,depth,
          role:child.delegation?.profile??'general',
          prompt:child.prompt.slice(0,180),
          state:child.state,
          dependencies:child.dependencies.slice(0,8),
          modelKey:child.modelKey??null,tokens,costUsd,
          reportedSummary:child.state==='completed'&&child.handoff?.summary
            ?child.handoff.summary.slice(0,240):null,
          lastTool:latestTool(child)
        });
        walk(child.id,depth+1);
      }
    };
    walk(root.id,1);
    answer[root.id]=result;
  }
  return answer;
}
