import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from '@sinclair/typebox';
import { Store, terminal, type Task, type Conversation, type Approval, type Usage } from './store.js';
import { LocalProviderUnavailableError, ProviderRateLimitError, type Harness, type HarnessPhase } from './harness.js';
import type { RelayModels } from './models.js';
import type { CapabilityRegistry } from './capabilities.js';
import { Gateway, type AtlasTransport } from './gateway.js';
import { AtlasContextService, type AtlasContext } from './atlas-context.js';

export interface Limits { concurrency:number; queue:number; sessionUsd:number; globalUsd:number; sessionTokens:number; reserveUsd:number; maxRunMs:number; }
export class ConversationConflictError extends Error {}
export class ConversationNotFoundError extends Error {}
export class SessionCleanupError extends Error {}
export class Engine {
  private active=new Map<string,AbortController>();
  private scheduled=false;
  private stopped=false;
  private jobs=new Set<Promise<void>>();
  readonly gateway?:Gateway;
  readonly atlasContext?:AtlasContextService;
  constructor(readonly store:Store, private harness:Harness, readonly limits:Limits, atlas?:AtlasTransport,devTasks:Record<string,string[]>={},readonly modelRegistry?:RelayModels,readonly capabilities?:CapabilityRegistry) {
    if(!Number.isInteger(limits.concurrency)||limits.concurrency<1||limits.concurrency>4)throw new Error('Concurrency must be 1–4');
    for(const value of Object.values(limits))if(!Number.isFinite(value)||value<0)throw new Error('Invalid execution limit');
    if(limits.queue<1 || limits.maxRunMs<1000)throw new Error('Invalid queue or run timeout');
    if(atlas){this.gateway=new Gateway(store,atlas,devTasks,(...args)=>this.approve(...args));this.atlasContext=new AtlasContextService(atlas);}
    store.transaction(()=>{
      for(const task of store.all<Task>('tasks'))if(['running','awaiting_approval'].includes(task.state)) {
        task.state='interrupted';task.error='Server restarted during execution. Reconcile tools before retrying.';store.save('tasks',task);
        store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'task',state:'interrupted'});
      }
      for(const approval of store.all<Approval>('approvals'))if(approval.state==='pending') { approval.state='rejected';store.save('approvals',approval); }
    });
  }
  start() {
    // A previous process can crash after DB purge but before Pi cleanup.
    // Retry only durable tombstones; failure never makes a chat visible again.
    void this.cleanupPendingSessions().catch(()=>console.error('Relay session cleanup pending; retry on next startup'));
    this.kick();
  }
  private async cleanupPendingSessions() {
    if(!this.harness.deleteConversationSessions)throw new SessionCleanupError('Session cleanup unavailable');
    for(const id of this.store.pendingSessionDeletions()) {
      try {
        // After a crash or failed checkpoint, historical WAL frames may
        // still contain transcript data. Never clear the tombstone first.
        this.store.checkpointDeletedHistory();
        await this.harness.deleteConversationSessions(id);
        this.store.sessionDeletionComplete(id);
      } catch {
        // Keep the tombstone. Never log the filesystem exception or contents.
        console.error('Relay session cleanup pending', {conversationId:id});
      }
    }
  }
  renameConversation(id:string,title:unknown):Conversation {
    const c=this.store.get<Conversation>('conversations',id);
    if(!c)throw new ConversationNotFoundError('Conversation not found');
    if(typeof title!=='string')throw new Error('Title must be 1–120 characters');
    const trimmed=title.trim();
    if(!trimmed || [...trimmed].length>120 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed))
      throw new Error('Title must be 1–120 characters without control characters');
    // Preserve modelKey and any future optional conversation metadata.
    const renamed={...c,title:trimmed,manualTitle:true};
    this.store.save('conversations',renamed);
    return renamed;
  }
  async deleteConversation(id:string):Promise<void> {
    if(!this.harness.deleteConversationSessions)throw new SessionCleanupError('Session cleanup unavailable');
    if(!this.store.get<Conversation>('conversations',id))throw new ConversationNotFoundError('Conversation not found');
    const all=this.tasks();
    const owned=all.filter(t=>t.conversationId===id);
    const removed=new Set(owned.map(t=>t.id));
    if(owned.some(t=>['queued','running','awaiting_approval','interrupted'].includes(t.state) || this.active.has(t.id)))
      throw new ConversationConflictError('Conversation has active or uncertain tasks');
    if(all.some(t=>t.conversationId!==id && (removed.has(t.parentId??'')||removed.has(t.attemptOf??'')||t.dependencies.some(dep=>removed.has(dep)))))
      throw new ConversationConflictError('Other conversations depend on this conversation');
    if(this.store.all<Approval>('approvals').some(a=>removed.has(a.taskId)&&a.state==='pending'))
      throw new ConversationConflictError('Conversation has pending approvals');
    const outstanding=owned.flatMap(t=>this.store.invocationRecords(t.id))
      .filter(r=>r.state!=='completed' &&
        !(r.kind==='mcp_read'&&['failed_read','reconciled_read'].includes(r.state)));
    if(outstanding.length){
      if(outstanding.every(r=>r.kind==='mcp_read'&&['uncertain','dispatched','validating'].includes(r.state)))
        throw new ConversationConflictError('Conversation has uncertain read-only MCP invocations');
      throw new ConversationConflictError('Conversation has uncertain tool invocations');
    }
    // Checks, ledger retirement, record purge and tombstone creation are all
    // synchronous with no event-loop yield. No task can be scheduled between
    // validation and the transaction.
    this.store.purgeConversation(id,owned);
    try {
      // A committed SQLite purge alone can leave old message bytes in the
      // live WAL. Verify TRUNCATE before acknowledging a full purge.
      this.store.checkpointDeletedHistory();
      await this.harness.deleteConversationSessions(id);
      this.store.sessionDeletionComplete(id);
    } catch {
      // The chat was logically deleted, but checkpoint or Pi cleanup failed.
      // The durable tombstone makes the remaining work retryable on startup.
      throw new SessionCleanupError('Conversation deleted; durable cleanup pending');
    }
  }
  // Explicit owner acknowledgement for read-only MCP calls whose outcome is
  // indeterminate. This never retires Atlas or mutating tool operations.
  reconcileMcpReadInvocations(conversationId:string,confirmed:boolean):number {
    if(confirmed!==true)throw new Error('Explicit read reconciliation confirmation required');
    if(!this.store.get<Conversation>('conversations',conversationId))
      throw new ConversationNotFoundError('Conversation not found');
    const owned=this.tasks(conversationId);
    if(owned.some(t=>!terminal(t.state)||t.state==='interrupted'||this.active.has(t.id)))
      throw new ConversationConflictError('Conversation has active or uncertain tasks');
    if(this.store.all<Approval>('approvals').some(a=>a.state==='pending'&&owned.some(t=>t.id===a.taskId)))
      throw new ConversationConflictError('Conversation has pending approvals');
    const records=owned.flatMap(task=>this.store.invocationRecords(task.id).map(record=>({task,record})));
    const blocking=records.filter(({record})=>record.state!=='completed' &&
      !(record.kind==='mcp_read'&&['failed_read','reconciled_read'].includes(record.state)));
    if(blocking.some(({record})=>record.kind!=='mcp_read' ||
        !['uncertain','dispatched','validating'].includes(record.state)))
      throw new ConversationConflictError('Conversation has uncertain tool invocations');
    // Synchronous transaction prevents partially reconciled receipts. Keep
    // an audit event; never change the historical tool execution outcome.
    this.store.transaction(()=>{
      for(const {task,record} of blocking){
        this.store.save('invocations',{...record,state:'reconciled_read',
          reconciledAt:new Date().toISOString()});
        this.store.event(conversationId,{taskId:task.id,agentRunId:task.id,
          invocationId:record.invocationId??null,tool:record.toolName??null,
          type:'reconciliation',state:'read_reconciled'});
      }
    });
    return blocking.length;
  }
  conversation(modelKey?:string) {
    if(this.store.all('conversations').length>=1000)throw new Error('Conversation limit reached');
    if(modelKey!==undefined && (!this.modelRegistry || !this.modelRegistry.models.some(m=>m.key===modelKey)))throw new Error('Invalid model selection');
    const key=modelKey??this.modelRegistry?.defaultKey;
    const c:Conversation={id:randomUUID(),title:'New conversation',createdAt:new Date().toISOString(),...(key?{modelKey:key}:{})}; this.store.save('conversations',c);return c;
  }
  async updateContext(conversationId:string,projectId:unknown,checkoutId:unknown):Promise<Conversation> {
    const initial=this.store.get<Conversation>('conversations',conversationId);
    if(!initial)throw new Error('Conversation not found');
    if(this.tasks(conversationId).some(t=>!terminal(t.state)))throw new Error('Conversation has an active task');
    if(!this.atlasContext && !(projectId===null&&checkoutId===null))throw new Error('Atlas not configured');
    const context:AtlasContext|null=this.atlasContext
      ?await this.atlasContext.validate(projectId,checkoutId)
      :null;
    const current=this.store.get<Conversation>('conversations',conversationId);
    if(!current)throw new Error('Conversation not found');
    if(this.tasks(conversationId).some(t=>!terminal(t.state)))throw new Error('Conversation has an active task');
    if(JSON.stringify(current.atlasContext??null)!==JSON.stringify(initial.atlasContext??null))
      throw new Error('Conversation context changed; refresh and retry');
    current.atlasContext=context;
    this.store.save('conversations',current);
    return current;
  }
  tasks(conversationId?:string) { return this.store.all<Task>('tasks').filter(t=>!conversationId||t.conversationId===conversationId); }
  usage(conversationId?:string) {
    const all=this.tasks(conversationId).flatMap(t=>t.usage);
    const retired=conversationId?null:this.store.retiredUsage();
    return {costUsd:all.reduce((s,u)=>s+(u.costUsd??0),retired?.costUsd??0),tokens:all.reduce((s,u)=>s+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),retired?.tokens??0),
      unknown:(retired?.unknown??false)||all.some(u=>u.costUsd===null || u.input===null || u.output===null),
      costKind:(all.length+(retired?.count??0)) && all.every(u=>u.costKind==='measured') && (retired?.measured??true)?'measured':'estimated'};
  }
  private budget(conversationId:string) {
    const local=this.usage(conversationId),global=this.usage();
    const reserved=this.active.size*this.limits.reserveUsd;
    if((this.limits.sessionUsd>0 && (local.unknown || local.costUsd+this.limits.reserveUsd>this.limits.sessionUsd)) ||
       (this.limits.globalUsd>0 && (global.unknown || global.costUsd+reserved+this.limits.reserveUsd>this.limits.globalUsd)) ||
       (this.limits.sessionTokens>0 && (local.unknown || local.tokens>=this.limits.sessionTokens))) throw new Error('Inference budget exhausted or usage unavailable');
  }
  enqueue(conversationId:string,prompt:string,requestId:string,dependencies:string[]=[],parentId:string|null=null,attemptOf:string|null=null) {
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>6000)throw new Error('Message length must be 1–6000');
    if(typeof requestId!=='string'||!requestId.match(/^[a-zA-Z0-9_-]{8,100}$/))throw new Error('A stable requestId is required');
    const c=this.store.get<Conversation>('conversations',conversationId);if(!c)throw new Error('Conversation not found');
    const existing=this.tasks(conversationId).find(t=>t.requestId===requestId);
    if(existing) { if(existing.prompt!==prompt || JSON.stringify(existing.dependencies)!==JSON.stringify(dependencies))throw new Error('Request identity conflict');return existing; }
    const tasks=this.tasks();
    if(tasks.length>=10000 || tasks.filter(t=>!terminal(t.state)).length>=this.limits.queue)throw new Error('Task queue is full');
    if(!Array.isArray(dependencies)||dependencies.length>8||dependencies.some(id=>!tasks.some(t=>t.id===id)))throw new Error('Invalid dependencies');
    if(parentId && !tasks.some(t=>t.id===parentId))throw new Error('Parent task not found');
    this.budget(conversationId);
    const task:Task={id:randomUUID(),conversationId,requestId,prompt,state:'queued',createdAt:new Date().toISOString(),parentId,dependencies,attemptOf,result:'',error:null,usage:[],atlasContext:c.atlasContext??null};
    this.store.transaction(()=>{
      this.store.save('tasks',task);
      if(!c.manualTitle && c.title==='New conversation') { c.title=prompt.slice(0,55);this.store.save('conversations',c); }
      this.store.event(conversationId,{taskId:task.id,agentRunId:task.id,type:'task',state:'queued'});
    });
    this.kick();return task;
  }
  private kick() { if(this.scheduled||this.stopped)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.pump();}); }
  private pump() {
    if(this.stopped)return;
    const tasks=this.tasks();
    for(const task of tasks.filter(t=>t.state==='queued')) {
      const deps=task.dependencies.map(id=>this.store.get<Task>('tasks',id)!);
      if(deps.some(d=>terminal(d.state)&&d.state!=='completed')) { this.finish(task,'failed','A dependency did not complete');continue; }
      if(deps.some(d=>d.state!=='completed'))continue;
      if(this.active.size>=this.limits.concurrency)break;
      if(tasks.some(t=>t.conversationId===task.conversationId&&this.active.has(t.id)))continue;
      try { this.budget(task.conversationId); } catch(e) { this.finish(task,'failed','Inference budget exhausted or usage unavailable');continue; }
      const controller=new AbortController();this.active.set(task.id,controller);
      task.state='running';this.store.save('tasks',task);this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'task',state:'running'});
      const job=this.execute(task,controller,deps).finally(()=>{this.active.delete(task.id);this.jobs.delete(job);this.kick();});
      this.jobs.add(job);
    }
  }
  private finish(task:Task,state:Task['state'],error:string|null=null) {
    task.state=state;task.error=error;
    this.store.transaction(()=>{this.store.save('tasks',task);this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'task',state});});
  }
  private async execute(task:Task,controller:AbortController,deps:Task[]) {
    let phase:HarnessPhase|'atlas_tool_discovery'|'pi_initialization'='atlas_tool_discovery';
    const timeout=setTimeout(()=>controller.abort(new Error('Execution time limit reached')),this.limits.maxRunMs);
    try {
      // Atlas discovery is optional for ordinary chat. Never equate an offline MCP with tool permission.
      let atlasAvailable=true;
      let tools:Awaited<ReturnType<Gateway['tools']>>=[];
      if(this.gateway) {
        try { tools=await this.gateway.tools(task,controller.signal); }
        catch { controller.signal.throwIfAborted();atlasAvailable=false;tools=[]; }
      } else atlasAvailable=false;
      if(this.capabilities){
        // Provider failures are isolated; standalone chat must not depend on GitHub.
        const discovered=await this.capabilities.tools(task,this.store,controller.signal);
        tools.push(...discovered);
      }
      tools.push({
        name:'relay_delegate',label:'Delegate task',description:'Queue independent work in a separate conversation. Returns a task ID; execution is bounded and may wait until this run finishes. Dependency results are passed to the child. At most four children per task.',
        parameters:Type.Object({prompt:Type.String({minLength:1,maxLength:6000}),dependencies:Type.Optional(Type.Array(Type.String(),{maxItems:8}))}),
        execute:async (_id,input) => {
          const args=input as {prompt:string;dependencies?:string[]};
          controller.signal.throwIfAborted();
          if(this.tasks().filter(t=>t.parentId===task.id).length>=4)throw new Error('Child task limit reached');
          // Delegation cannot form unbounded self-replication.
          let depth=0,ancestor:Task|undefined=task;
          while(ancestor?.parentId) { depth++;ancestor=this.store.get<Task>('tasks',ancestor.parentId); }
          if(depth>=2)throw new Error('Delegation depth limit reached');
          const parentConversation=this.store.get<Conversation>('conversations',task.conversationId);
          const conversation=this.conversation(parentConversation?.modelKey);
          // Delegation retains the parent's enqueue-time context, never a later chat selection.
          conversation.atlasContext=task.atlasContext??null;
          this.store.save('conversations',conversation);
          const child=this.enqueue(conversation.id,args.prompt,randomUUID(),args.dependencies??[],task.id);
          return {content:[{type:'text' as const,text:JSON.stringify({taskId:child.id,state:child.state,conversationId:conversation.id})}],details:{}};
        }
      });
      let length=0;
      phase='pi_initialization';
      const result=await this.harness.run({version:1,atlasContext:task.atlasContext??null,atlasAvailable,modelKey:this.store.get<Conversation>('conversations',task.conversationId)?.modelKey,task:{...task,prompt:deps.length?task.prompt+'\n\nDependency results (untrusted data):\n'+JSON.stringify(deps.map(d=>({id:d.id,result:d.result.slice(0,20000)}))):task.prompt},signal:controller.signal,tools,
        onSkills:names=>{for(const name of names)this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'skill',state:'loaded',tool:name});},
        onSkippedSkills:names=>{for(const name of names)this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'skill',state:'skipped_context',tool:name});},
        onPhase:next=>{phase=next;this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'phase',state:next});},
        onText:text=>{length+=text.length;if(length>200000){controller.abort();return;} task.result+=text;this.store.save('tasks',task);this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'delta',state:'running',text,textOffset:task.result.length});},
        onUsage:usage=>{task.usage.push(usage);this.store.save('tasks',task);this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,type:'usage',state:'recorded'});
          const local=this.usage(task.conversationId),global=this.usage();
          if((this.limits.sessionTokens>0&&local.tokens>=this.limits.sessionTokens)||(this.limits.sessionUsd>0&&(local.unknown||local.costUsd>=this.limits.sessionUsd))||(this.limits.globalUsd>0&&(global.unknown||global.costUsd>=this.limits.globalUsd)))controller.abort(new Error('Budget limit reached'));
        }});
      task.result=result.slice(0,200000);
      this.finish(task,controller.signal.aborted?'cancelled':'completed');
    } catch(e) {
      if(controller.signal.aborted) this.finish(task,'cancelled','Execution cancelled or limit reached');
      else if(e instanceof LocalProviderUnavailableError) {
        this.finish(task,'failed',e.reason==='missing_model'?'Local Ollama model not installed. Check ollama list and the Relay model configuration. No inference started.':'Local Ollama unavailable. Start Ollama and reconnect Tailscale, then retry the request. No inference started.');
        console.warn('Relay local provider unavailable',{taskId:task.id,phase,reason:e.reason});
      }
      else if(e instanceof ProviderRateLimitError) {
        // Pi may already have retried the rate-limited provider internally.
        // Never repeat a run automatically: tools may have dispatched earlier.
        this.finish(task,'failed','OpenRouter rate limit reached (HTTP 429). Free-model quotas may be shared across models. Check OpenRouter usage and retry after the limit resets; reconcile any dispatched Atlas operation before retrying.');
        console.warn('Relay provider rate limited',{taskId:task.id,phase});
      }
      else {
        // Report only bounded, code-owned phase/type information; never log or
        // persist arbitrary SDK error strings, which may contain credentials.
        const type=e instanceof Error && ['TypeError','RangeError','SyntaxError','AbortError'].includes(e.name)?e.name:'Error';
        this.finish(task,'failed',`Execution failed during ${phase} (${type}). Check Relay configuration; reconcile any dispatched operation.`);
        console.error('Relay execution failure',{taskId:task.id,phase,errorType:type});
      }
    }
    finally { clearTimeout(timeout); }
  }
  async cancel(id:string) {
    const task=this.store.get<Task>('tasks',id);if(!task)throw new Error('Task not found');
    if(terminal(task.state))return task;
    const active=this.active.get(id);
    if(active)active.abort();else this.finish(task,'cancelled');
    for(const a of this.store.all<Approval>('approvals'))if(a.taskId===id&&a.state==='pending'){a.state='rejected';this.store.save('approvals',a);}
    return this.store.get<Task>('tasks',id)!;
  }
  retry(id:string,confirmed:boolean) {
    const old=this.store.get<Task>('tasks',id);if(!old||!terminal(old.state)||old.state==='completed')throw new Error('Task cannot be retried');
    if(!confirmed)throw new Error('Explicit reconciliation confirmation is required before retrying');
    // A new conversation avoids replaying partially completed Pi context or tool effects.
    const source=this.store.get<Conversation>('conversations',old.conversationId);
    const conversation=this.conversation(source?.modelKey);
    // A confirmed retry reuses the failed run's pinned snapshot, not mutable source context.
    conversation.atlasContext=old.atlasContext??null;
    this.store.save('conversations',conversation);
    return this.enqueue(conversation.id,old.prompt,randomUUID(),old.dependencies,old.parentId,old.id);
  }
  private async approve(task:Task,invocationId:string,tool:string,args:Record<string,unknown>,signal:AbortSignal) {
    const approval:Approval={id:randomUUID(),taskId:task.id,invocationId,tool,args,state:'pending'};
    this.store.save('approvals',approval);task.state='awaiting_approval';this.store.save('tasks',task);
    this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,invocationId,type:'approval',tool,state:'pending'});
    while(true) {
      signal.throwIfAborted();
      const current=this.store.get<Approval>('approvals',approval.id)!;
      if(current.state!=='pending') {
        if(current.state==='rejected')throw new Error('Approval rejected');
        task.state='running';this.store.save('tasks',task);return;
      }
      await delay(200,undefined,{signal});
    }
  }
  decide(id:string,approved:boolean) {
    const a=this.store.get<Approval>('approvals',id);if(!a||a.state!=='pending')throw new Error('Approval is no longer pending');
    const task=this.store.get<Task>('tasks',a.taskId)!;
    if(task.state!=='awaiting_approval')throw new Error('Task is not awaiting approval');
    a.state=approved?'approved':'rejected';this.store.save('approvals',a);
    this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.id,invocationId:a.invocationId,type:'approval',tool:a.tool,state:a.state});
    return a;
  }
  async stop() { this.stopped=true;for(const c of this.active.values())c.abort();await Promise.allSettled(this.jobs); }
}
