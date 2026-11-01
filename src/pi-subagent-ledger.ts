import { randomUUID } from 'node:crypto';
import type { SubagentTransition } from './pi-delegation.js';
import type { Store, Task, Conversation, State, Usage } from './store.js';
import { terminal } from './store.js';
import { READ_TOOLS } from './gateway.js';

/**
 * Projection, not a second executor. Pi SDK sessions own child execution; Relay persists identities and events so Tasks & Agents can show
 * progress and restart recovery can mark interrupted children honestly.
 */
export class PiSubagentLedger {
  private readonly childIds=new Map<string,string>();
  constructor(private readonly store:Store,private readonly root:Task) {}

  /** Charge real Pi child model usage to the durable child, not the parent. */
  recordUsage(agentId:string,usage:Usage):Task|undefined {
    const root=this.store.get<Task>('tasks',this.root.id);
    if(!root||root.agentRunId!==this.root.agentRunId||!['running','awaiting_approval'].includes(root.state))return;
    const childId=this.childIds.get(agentId);
    const child=childId?this.store.get<Task>('tasks',childId):undefined;
    if(!child||terminal(child.state))return;
    this.store.transaction(()=>{
      child.usage.push(usage);
      this.store.save('tasks',child);
      this.store.event(child.conversationId,{
        taskId:child.id,parentTaskId:this.root.id,
        agentId,agentRunId:child.agentRunId??null,type:'usage',state:'recorded'});
    });
    return child;
  }
  /** A nested Pi MCP result is independent, source-verified execution evidence. */
  recordRead(agentId:string,tool:string,success:boolean):void {
    const root=this.store.get<Task>('tasks',this.root.id);
    const childId=this.childIds.get(agentId);
    const child=childId?this.store.get<Task>('tasks',childId):undefined;
    if(!root||!['running','awaiting_approval'].includes(root.state)||root.agentRunId!==this.root.agentRunId||
        !child||terminal(child.state)||!(
          /^mcp__[a-z0-9_]+__[a-zA-Z0-9_]+$/.test(tool) ||
          (tool.startsWith('atlas_')&&READ_TOOLS.has(tool.slice(6)))))return;
    // The native MCP hook already recorded the actual child invocation.
    // This is only a parent UI notification, never a second synthetic receipt.
    this.store.event(this.root.conversationId,{taskId:this.root.id,
      agentRunId:this.root.agentRunId??null,childTaskId:child.id,
      tool,type:'delegated_tool',state:success?'completed':'failed'});
  }

  record(event:SubagentTransition):Task|undefined {
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(event.agentId))return;
    const currentRoot=this.store.get<Task>('tasks',this.root.id);
    // Never resurrect a stopped, retried or interrupted parent.
    if(!currentRoot||currentRoot.agentRunId!==this.root.agentRunId ||
        !['running','awaiting_approval'].includes(currentRoot.state))return;
    const priorId=this.childIds.get(event.agentId);
    let child=priorId?this.store.get<Task>('tasks',priorId):undefined;
    if(child&&terminal(child.state))return child;
    this.store.transaction(()=>{
      if(!child) {
        const conversationId=event.task?.conversationId??randomUUID(),id=event.task?.id??randomUUID();
        const research=event.profile==='research';
        const conversation:Conversation={id:conversationId,title:research?'Pi research subagent':'Pi analysis subagent',createdAt:new Date().toISOString(),
          internalParentConversationId:this.root.conversationId};
        this.store.save('conversations',conversation);
        child={id,conversationId,requestId:'pi-'+id,
          prompt:research?'Pi delegated research':'Pi delegated analysis',
          state:'running',createdAt:new Date().toISOString(),parentId:this.root.id,
          dependencies:[],attemptOf:null,result:'',error:null,usage:[],
          agentId:event.agentId,agentRunId:randomUUID(),modelKey:this.root.modelKey,
          kind:'pi_subagent'};
        if(event.task)child={...event.task};
        this.store.save('tasks',child);
        this.store.event(conversationId,{taskId:id,agentId:event.agentId,
          agentRunId:child.agentRunId,parentTaskId:this.root.id,
          type:'task',state:'running'});
        this.store.event(this.root.conversationId,{taskId:this.root.id,
          agentId:this.root.agentId??null,agentRunId:this.root.agentRunId??null,
          childTaskId:id,type:'delegation',state:'running'});
      }
      const verifiedCompletion=event.status==='completed'&&typeof event.result==='string';
      const next:State=verifiedCompletion?'completed':
        event.status==='failed'||event.status==='completed'?'failed':
        event.status==='stopped'?'cancelled':'running';
      child!.state=next;
      if(verifiedCompletion)child!.result=event.result!.slice(0,12000);
      if(next==='failed'||next==='cancelled')
        child!.error=(event.error||'Pi subagent did not provide a completed result').slice(0,500);
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
