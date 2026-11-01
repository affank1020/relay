import { randomUUID } from 'node:crypto';
import type { SubagentTransition } from './pi-subagents-rpc.js';
import type { Store, Task, Conversation, State } from './store.js';
import { terminal } from './store.js';

/**
 * Projection, not a second executor. pi-subagents owns child scheduling and
 * execution; Relay persists identities and events so Tasks & Agents can show
 * progress and restart recovery can mark interrupted children honestly.
 */
export class PiSubagentLedger {
  private readonly childIds=new Map<string,string>();
  constructor(private readonly store:Store,private readonly root:Task) {}

  record(event:SubagentTransition):Task|undefined {
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(event.agentId))return;
    const currentRoot=this.store.get<Task>('tasks',this.root.id);
    // Never resurrect a stopped, retried or interrupted parent.
    if(!currentRoot||currentRoot.agentRunId!==this.root.agentRunId ||
        currentRoot.state!=='running')return;
    const priorId=this.childIds.get(event.agentId);
    let child=priorId?this.store.get<Task>('tasks',priorId):undefined;
    if(child&&terminal(child.state))return child;
    this.store.transaction(()=>{
      if(!child) {
        const conversationId=randomUUID(),id=randomUUID();
        const conversation:Conversation={id:conversationId,title:'Pi subagent',createdAt:new Date().toISOString(),
          internalParentConversationId:this.root.conversationId};
        this.store.save('conversations',conversation);
        child={id,conversationId,requestId:'pi-'+id,prompt:'Pi delegated analysis',
          state:'running',createdAt:new Date().toISOString(),parentId:this.root.id,
          dependencies:[],attemptOf:null,result:'',error:null,usage:[],
          agentId:event.agentId,agentRunId:randomUUID(),modelKey:this.root.modelKey,
          kind:'pi_subagent'};
        this.store.save('tasks',child);
        this.store.event(conversationId,{taskId:id,agentId:event.agentId,
          agentRunId:child.agentRunId,parentTaskId:this.root.id,
          type:'task',state:'running'});
        this.store.event(this.root.conversationId,{taskId:this.root.id,
          agentId:this.root.agentId??null,agentRunId:this.root.agentRunId??null,
          childTaskId:id,type:'delegation',state:'running'});
      }
      const next:State=event.status==='completed'?'completed':
        event.status==='failed'?'failed':event.status==='stopped'?'cancelled':'running';
      child!.state=next;
      if(event.status==='completed')child!.result=(event.result??'').slice(0,12000);
      if(event.status==='failed'||event.status==='stopped')
        child!.error=(event.error||'Pi subagent did not complete').slice(0,500);
      this.store.save('tasks',child!);
      this.store.event(child!.conversationId,{taskId:child!.id,
        agentId:child!.agentId??null,agentRunId:child!.agentRunId??null,
        parentTaskId:this.root.id,type:'pi_subagent',state:next});
      this.store.event(this.root.conversationId,{taskId:this.root.id,
        agentId:this.root.agentId??null,agentRunId:this.root.agentRunId??null,
        childTaskId:child!.id,type:'delegation',state:next});
    });
    // Install the in-memory map only after the SQLite transaction commits.
    // A rolled-back foreign key or IO failure must not leave a phantom child.
    if(!priorId&&child)this.childIds.set(event.agentId,child.id);
    return child;
  }
}
