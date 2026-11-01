import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from '@sinclair/typebox';
import { Store, terminal, type Task, type Conversation, type Approval, type Usage, type InvocationRecord } from './store.js';
import { LocalProviderUnavailableError, ProviderRateLimitError, type Harness, type HarnessPhase } from './harness.js';
import type { RelayModels } from './models.js';
import type { CapabilityRegistry } from './capabilities.js';
import { profilePrompt } from './agent-profiles.js';
import { agentHandoff } from './handoff.js';
import { Gateway, READ_TOOLS, type AtlasTransport } from './gateway.js';
import { originatingConversation, completedDependencyReceipts, delegationPolicy, handoffPrompt, used, validateDependencies, type DelegationSnapshot, type DependencyReceipt } from './orchestration.js';
import { AtlasContextService, type AtlasContext } from './atlas-context.js';

export interface Limits { concurrency:number; queue:number; sessionUsd:number; globalUsd:number; sessionTokens:number; reserveUsd:number; maxRunMs:number; }
export class ConversationConflictError extends Error {}
export class ConversationNotFoundError extends Error {}
export class SessionCleanupError extends Error {}
// Deletion and read-only reconciliation must agree on which side effects are
// terminal. Only pre-dispatch denied GitHub writes are known to be harmless:
// dispatched or uncertain mutations are never eligible for read reconciliation.
const settledInvocation=(record:InvocationRecord):boolean=>
  record.state==='completed' ||
  (record.kind==='mcp_read' && ['failed_read','reconciled_read'].includes(record.state)) ||
  (record.kind==='mcp_write' && record.state==='denied_before_dispatch');
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
        store.event(task.conversationId,{taskId:task.id,agentRunId:task.agentRunId??null,agentId:task.agentId??null,type:'task',state:'interrupted'});
      }
      // A join whose execution was interrupted is not silently replayed.
      for(const task of store.all<Task>('tasks'))if(task.state==='waiting_children'&&task.joinTaskId) {
        const join=store.get<Task>('tasks',task.joinTaskId);
        if(!join || join.state==='interrupted' || join.state==='failed' || join.state==='cancelled') {
          task.state='interrupted';task.error='Child synthesis interrupted; reconcile before retrying.';
          store.save('tasks',task);
          store.event(task.conversationId,{taskId:task.id,agentRunId:task.agentRunId??null,type:'task',state:'interrupted'});
        }
      }
      for(const approval of store.all<Approval>('approvals'))if(approval.state==='pending') { approval.state='rejected';store.save('approvals',approval); }
      // A GitHub write remains strictly pre-dispatch until its ledger state
      // becomes 'dispatched', synchronously before the network call. Crashes
      // during user review cannot leave an ambiguous pending write forever.
      // Dispatched/uncertain records are NEVER downgraded or replayed.
      for(const row of store.db.prepare('SELECT id,data FROM invocations').all()){
        const record=JSON.parse(String(row.data)) as {id:string;taskId?:string;kind?:string;state?:string;
          toolName?:string;invocationId?:string};
        if(record.kind!=='mcp_write'||record.state!=='validating')continue;
        store.save('invocations',{...record,state:'denied_before_dispatch'});
        const task=record.taskId?store.get<Task>('tasks',record.taskId):undefined;
        if(task)store.event(task.conversationId,{taskId:task.id,agentId:task.agentId??null,
          agentRunId:task.agentRunId??null,tool:record.toolName??null,
          invocationId:record.invocationId??null,type:'tool',state:'denied'});
      }
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
    const conversations=this.store.all<Conversation>('conversations');
    if(!conversations.some(c=>c.id===id))throw new ConversationNotFoundError('Conversation not found');
    const all=this.tasks(),byId=new Map(all.map(t=>[t.id,t]));
    const byConversation=new Map<string,Task[]>();
    for(const task of all) {
      const owned=byConversation.get(task.conversationId)??[];
      owned.push(task);byConversation.set(task.conversationId,owned);
    }
    // Only genuine internal descendants can be deleted with the user-facing
    // root. A legacy child must carry an admitted delegation and all tasks in
    // its session must point into the subtree. Unrelated user chats, retries
    // and externally referenced work are never silently deleted.
    const included=new Set([id]);
    const order=[id];
    let changed=true;
    while(changed) {
      changed=false;
      for(const c of conversations) {
        if(included.has(c.id))continue;
        const tasks=byConversation.get(c.id)??[];
        const explicitlyInternal=!!c.internalParentConversationId && included.has(c.internalParentConversationId);
        const legacyInternal=!c.internalParentConversationId && tasks.length>0 &&
          tasks.every(task=>!!task.parentId && !!task.delegation &&
            included.has(byId.get(task.parentId)?.conversationId??''));
        if(!explicitlyInternal && !legacyInternal)continue;
        included.add(c.id);order.push(c.id);changed=true;
      }
    }
    const removed=new Set(all.filter(t=>included.has(t.conversationId)).map(t=>t.id));
    if(all.some(t=>included.has(t.conversationId) &&
      (!terminal(t.state)||t.state==='interrupted'||this.active.has(t.id))))
      throw new ConversationConflictError('Conversation tree has active or uncertain tasks');
    if(all.some(t=>!included.has(t.conversationId) &&
      (removed.has(t.parentId??'')||removed.has(t.attemptOf??'')||
        t.dependencies.some(dep=>removed.has(dep)))))
      throw new ConversationConflictError('Other conversations depend on this conversation');
    if(all.some(t=>included.has(t.conversationId) && t.parentId && !included.has(byId.get(t.parentId)?.conversationId??'') &&
      (()=>{const parent=byId.get(t.parentId!);
        const join=parent?.joinTaskId?byId.get(parent.joinTaskId):undefined;
        return !parent || !terminal(parent.state) || !!(join&&!terminal(join.state));})()))
      throw new ConversationConflictError('Child results are still needed for parent synthesis');
    if(this.store.all<Approval>('approvals').some(a=>removed.has(a.taskId)&&a.state==='pending'))
      throw new ConversationConflictError('Conversation has pending approvals');
    const outstanding=all.filter(t=>removed.has(t.id)).flatMap(t=>this.store.invocationRecords(t.id))
      .filter(r=>!settledInvocation(r));
    if(outstanding.length) {
      if(outstanding.every(r=>r.kind==='mcp_read'&&['uncertain','dispatched','validating'].includes(r.state)))
        throw new ConversationConflictError('Conversation has uncertain read-only MCP invocations');
      throw new ConversationConflictError('Conversation has uncertain tool invocations');
    }
    const entries=order.reverse().map(conversationId=>{
      const tasks=byConversation.get(conversationId)??[];
      const roots=new Set(tasks.map(task=>originatingConversation(task,byId)));
      if(roots.size>1)throw new ConversationConflictError('Conversation has mixed task origins');
      // Empty, explicitly internal sessions still belong to the original
      // family's numeric budget, even though there is no transcript usage.
      let family=roots.values().next().value as string|undefined;
      if(!family) {
        family=conversationId;
        const seen=new Set<string>();
        while(true) {
          const c=conversations.find(c=>c.id===family);
          if(!c?.internalParentConversationId)break;
          if(seen.has(family))throw new ConversationConflictError('Invalid conversation provenance');
          seen.add(family);
          family=c.internalParentConversationId;
        }
      }
      return {id:conversationId,tasks,rootConversationId:family};
    });
    // Retirement, all transcript/receipt purges and every filesystem cleanup
    // tombstone commit atomically. No asynchronous gap before the transaction.
    this.store.purgeConversations(entries);
    try {
      // A SQLite purge alone can leave sensitive bytes in historical WAL
      // frames. Checkpoint once before deleting any Pi session directory.
      this.store.checkpointDeletedHistory();
      for(const entry of entries) {
        await this.harness.deleteConversationSessions(entry.id);
        this.store.sessionDeletionComplete(entry.id);
      }
    } catch {
      // Every remaining tombstone is retryable on startup, even if Pi cleanup
      // succeeded for an earlier descendant.
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
    const blocking=records.filter(({record})=>!settledInvocation(record));
    if(blocking.some(({record})=>record.kind!=='mcp_read' ||
        !['uncertain','dispatched','validating'].includes(record.state)))
      throw new ConversationConflictError('Conversation has uncertain tool invocations');
    // Synchronous transaction prevents partially reconciled receipts. Keep
    // an audit event; never change the historical tool execution outcome.
    this.store.transaction(()=>{
      for(const {task,record} of blocking){
        this.store.save('invocations',{...record,state:'reconciled_read',
          reconciledAt:new Date().toISOString()});
        this.store.event(conversationId,{taskId:task.id,agentId:task.agentId??null,
          agentRunId:task.agentRunId??null,invocationId:record.invocationId??null,tool:record.toolName??null,
          type:'reconciliation',state:'read_reconciled'});
      }
    });
    return blocking.length;
  }
  conversation(modelKey?:string,internalParentConversationId?:string) {
    const conversations=this.store.all<Conversation>('conversations');
    // Recognise pre-provenance child records when applying the user-chat cap.
    const legacyChildIds=new Set(this.tasks().filter(t=>!!t.parentId).map(t=>t.conversationId));
    const isInternal=(c:Conversation)=>!!c.internalParentConversationId||legacyChildIds.has(c.id);
    // Internal sessions have an independent safety cap; user chats retain 1,000.
    if(internalParentConversationId) {
      if(conversations.filter(isInternal).length>=10000)
        throw new Error('Internal conversation limit reached');
    } else if(conversations.filter(c=>!isInternal(c)).length>=1000)
      throw new Error('Conversation limit reached');
    if(modelKey!==undefined && (!this.modelRegistry || !this.modelRegistry.models.some(m=>m.key===modelKey)))throw new Error('Invalid model selection');
    const key=modelKey??this.modelRegistry?.defaultKey;
    const c:Conversation={id:randomUUID(),title:'New conversation',createdAt:new Date().toISOString(),
      ...(key?{modelKey:key}:{}),...(internalParentConversationId?{internalParentConversationId}:{})}; this.store.save('conversations',c);return c;
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
  isInternalConversation(c:Conversation):boolean {
    return !!c.internalParentConversationId || this.store.isInternalConversationId(c.id);
  }
  usage(conversationId?:string,knownTasks?:Task[]) {
    const all=(knownTasks??this.tasks(conversationId)).flatMap(t=>t.usage);
    const retired=conversationId?null:this.store.retiredUsage();
    return {costUsd:all.reduce((s,u)=>s+(u.costUsd??0),retired?.costUsd??0),tokens:all.reduce((s,u)=>s+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),retired?.tokens??0),
      unknown:(retired?.unknown??false)||all.some(u=>u.costUsd===null || u.input===null || u.output===null),
      costKind:(all.length+(retired?.count??0)) && all.every(u=>u.costKind==='measured') && (retired?.measured??true)?'measured':'estimated'};
  }
  private familyUsage(conversationId:string,parentId:string|null=null) {
    const all=this.tasks(),byId=new Map(all.map(task=>[task.id,task]));
    const parent=parentId?byId.get(parentId):null;
    if(parentId&&!parent)throw new Error('Parent task not found');
    const rootConversation=parent?originatingConversation(parent,byId):conversationId;
    // Every root turn in that conversation, all descendants, and all join
    // continuations share one session. Each record is counted exactly once.
    const family=all.filter(task=>originatingConversation(task,byId)===rootConversation);
    const usage=used(family.flatMap(task=>task.usage));
    const retired=this.store.retiredFamilyUsage(rootConversation);
    const reserved=family.filter(task=>this.active.has(task.id)).length*this.limits.reserveUsd;
    return {costUsd:usage.usd+retired.costUsd,tokens:usage.tokens+retired.tokens,
      unknown:usage.unknown||retired.unknown,reserved};
  }
  // A delegated budget applies to the whole descendant agent tree, not just
  // the agent's own Pi inference. Nested children and inference-only joins
  // cannot evade the ceiling by spending in separate internal conversations.
  private delegatedTreeExhausted(taskId:string|null,additionalUsd=0,abortActiveDescendants=false):boolean {
    if(!taskId)return false;
    const tasks=this.tasks(),byId=new Map(tasks.map(task=>[task.id,task]));
    let current=byId.get(taskId);
    const ancestors=new Set<string>();
    let exhausted=false;
    while(current) {
      if(ancestors.has(current.id))return true;
      ancestors.add(current.id);
      const parent=current.parentId??current.continuationOf;
      const policy=current.delegation;
      if(policy && (policy.maxTokens!==null || policy.maxCostUsd!==null)) {
        const descendants=tasks.filter(candidate=>{
          const visited=new Set<string>();
          let node:Task|undefined=candidate;
          while(node) {
            if(node.id===current!.id)return true;
            if(visited.has(node.id))return false;
            visited.add(node.id);
            const id:string|undefined=node.parentId??node.continuationOf;
            node=id?byId.get(id):undefined;
          }
          return false;
        });
        const total=used(descendants.flatMap(task=>task.usage));
        // Reserve only genuinely active runs; queued agents are admitted again
        // at dispatch. Include the proposed new run at the admission boundary.
        const reservations=descendants.filter(task=>this.active.has(task.id)).length*this.limits.reserveUsd;
        if((policy.maxTokens!==null&&(total.unknown||total.tokens>=policy.maxTokens))||
           (policy.maxCostUsd!==null&&(total.unknown||
             total.usd>=policy.maxCostUsd ||
             total.usd+reservations+additionalUsd>policy.maxCostUsd))) {
          exhausted=true;
          if(!abortActiveDescendants)return true;
          // A shared budget can be exhausted by one sibling while others
          // have no new usage receipt. Abort *every* live descendant of
          // each exhausted ancestor, including pending joins. Never abort
          // unrelated roots or ancestors that own the depleted branch.
          for(const child of descendants)
            this.active.get(child.id)?.abort(new Error('Delegated family budget exhausted'));
        }
      }
      current=parent?byId.get(parent):undefined;
      if(parent&&!current)return true; // missing ancestry fails closed
    }
    return exhausted;
  }
  private budget(conversationId:string,parentId:string|null=null,delegation?:DelegationSnapshot) {
    const family=this.familyUsage(conversationId,parentId),global=this.usage();
    const reserved=this.active.size*this.limits.reserveUsd;
    if(this.delegatedTreeExhausted(parentId,this.limits.reserveUsd))
      throw new Error('Delegated agent family budget exhausted');
    if((this.limits.sessionUsd>0 && (family.unknown || family.costUsd+family.reserved+this.limits.reserveUsd>this.limits.sessionUsd)) ||
       (this.limits.globalUsd>0 && (global.unknown || global.costUsd+reserved+this.limits.reserveUsd>this.limits.globalUsd)) ||
       (this.limits.sessionTokens>0 && (family.unknown || family.tokens>=this.limits.sessionTokens)) ||
       (delegation?.maxCostUsd!=null && this.limits.reserveUsd>delegation.maxCostUsd))
      throw new Error('Inference budget exhausted or usage unavailable');
  }
  enqueue(conversationId:string,prompt:string,requestId:string,dependencies:string[]=[],parentId:string|null=null,
    attemptOf:string|null=null,options:{delegation?:DelegationSnapshot;kind?:'agent'|'join';continuationOf?:string;agentId?:string;modelKey?:string;retryDependencyResults?:DependencyReceipt[];retryDetachedFromParentId?:string}={}) {
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>6000)throw new Error('Message length must be 1–6000');
    if(typeof requestId!=='string'||!requestId.match(/^[a-zA-Z0-9_-]{8,100}$/))throw new Error('A stable requestId is required');
    const c=this.store.get<Conversation>('conversations',conversationId);if(!c)throw new Error('Conversation not found');
    const existing=this.tasks(conversationId).find(t=>t.requestId===requestId);
    if(existing) {
      if(existing.prompt!==prompt || JSON.stringify(existing.dependencies)!==JSON.stringify(dependencies) ||
        existing.parentId!==parentId)throw new Error('Request identity conflict');
      return existing;
    }
    const tasks=this.tasks();
    if(tasks.length>=10000 || tasks.filter(t=>!terminal(t.state)).length>=this.limits.queue)throw new Error('Task queue is full');
    validateDependencies(tasks,conversationId,dependencies,parentId);
    const parent=parentId?tasks.find(t=>t.id===parentId):undefined;
    if(parentId && !parent)throw new Error('Parent task not found');
    if(parent && !attemptOf && (!['running','awaiting_approval'].includes(parent.state) || !options.delegation))
      throw new Error('Parent must be executing an admitted delegation');
    if(options.modelKey && this.modelRegistry && !this.modelRegistry.models.some(model=>model.key===options.modelKey))
      throw new Error('Invalid model selection');
    this.budget(conversationId,parentId,options.delegation);
    const task:Task={id:randomUUID(),conversationId,requestId,prompt,state:'queued',createdAt:new Date().toISOString(),
      parentId,dependencies:[...dependencies],attemptOf,result:'',error:null,usage:[],atlasContext:c.atlasContext??null,
      agentId:options.agentId??randomUUID(),agentRunId:randomUUID(),
      ...(options.modelKey??c.modelKey?{modelKey:options.modelKey??c.modelKey}:{}),
      ...(options.delegation?{delegation:options.delegation}:{}),
      ...(options.kind?{kind:options.kind}:{}),
      ...(options.continuationOf?{continuationOf:options.continuationOf}:{}),
      ...(options.retryDependencyResults?.length?{retryDependencyResults:options.retryDependencyResults}: {}),
      ...(options.retryDetachedFromParentId?{retryDetachedFromParentId:options.retryDetachedFromParentId}:{})};
    this.store.transaction(()=>{
      this.store.save('tasks',task);
      if(!c.manualTitle && c.title==='New conversation') { c.title=prompt.slice(0,55);this.store.save('conversations',c); }
      this.store.event(conversationId,{taskId:task.id,agentId:task.agentId,agentRunId:task.agentRunId,parentTaskId:parentId,type:'task',state:'queued'});
      if(parent) this.store.event(parent.conversationId,{taskId:parent.id,agentRunId:parent.agentRunId??null,
        agentId:parent.agentId??null,childTaskId:task.id,type:'delegation',state:'queued'});
    });
    this.kick();return task;
  }
  private kick() { if(this.scheduled||this.stopped)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.pump();}); }
  private pump() {
    if(this.stopped)return;
    // A waiting parent does not occupy a worker. Once every direct child is
    // terminal, persist exactly one synthesis continuation in its conversation.
    for(const parent of this.tasks().filter(task=>task.state==='waiting_children'&&!task.joinTaskId)) {
      const children=this.tasks().filter(task=>task.parentId===parent.id);
      if(!children.length || children.some(child=>!terminal(child.state)))continue;
      if(this.tasks().filter(t=>!terminal(t.state)).length>=this.limits.queue)continue;
      try { this.budget(parent.conversationId,parent.id); }
      catch {
        this.finish(parent,'failed','Inference budget exhausted before child synthesis');
        continue;
      }
      const join:Task={id:randomUUID(),conversationId:parent.conversationId,requestId:'join-'+parent.id,
        prompt:'Synthesize delegated results',state:'queued',createdAt:new Date().toISOString(),
        parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[],
        atlasContext:parent.atlasContext??null,agentId:parent.agentId??randomUUID(),
        agentRunId:randomUUID(),modelKey:parent.modelKey,kind:'join',continuationOf:parent.id};
      this.store.transaction(()=>{
        // The parent is the authoritative join lock after a crash/restart.
        const current=this.store.get<Task>('tasks',parent.id);
        if(!current||current.state!=='waiting_children'||current.joinTaskId)throw new Error('Join already claimed');
        current.joinTaskId=join.id;
        this.store.save('tasks',current);this.store.save('tasks',join);
        this.store.event(parent.conversationId,{taskId:join.id,agentId:join.agentId,agentRunId:join.agentRunId,
          parentTaskId:parent.id,type:'join',state:'queued'});
      });
    }
    const tasks=this.tasks();
    for(const task of tasks.filter(t=>t.state==='queued')) {
      const deps=task.dependencies.map(id=>this.store.get<Task>('tasks',id)!);
      if(deps.some(d=>terminal(d.state)&&d.state!=='completed')) { this.finish(task,'failed','A dependency did not complete');continue; }
      if(deps.some(d=>d.state!=='completed'))continue;
      if(this.active.size>=this.limits.concurrency)break;
      if(tasks.some(t=>t.conversationId===task.conversationId&&this.active.has(t.id)))continue;
      try { this.budget(task.conversationId,task.parentId??task.continuationOf??null,task.delegation); }
      catch { this.finish(task,'failed','Inference budget exhausted or usage unavailable');continue; }
      const controller=new AbortController();this.active.set(task.id,controller);
      task.state='running';this.store.save('tasks',task);
      this.store.event(task.conversationId,{taskId:task.id,agentId:task.agentId??null,
        agentRunId:task.agentRunId??null,parentTaskId:task.parentId??task.continuationOf??null,type:'task',state:'running'});
      if(task.parentId) {
        const parent=this.store.get<Task>('tasks',task.parentId);
        if(parent)this.store.event(parent.conversationId,{taskId:parent.id,agentRunId:parent.agentRunId??null,
          childTaskId:task.id,type:'delegation',state:'running'});
      }
      const job=this.execute(task,controller,deps).finally(()=>{this.active.delete(task.id);this.jobs.delete(job);this.kick();});
      this.jobs.add(job);
    }
  }
  private finish(task:Task,state:Task['state'],error:string|null=null) {
    task.state=state;task.error=error;
    if(state==='completed'&&(task.parentId||task.delegation))task.handoff=agentHandoff(task.result);
    this.store.transaction(()=>{
      this.store.save('tasks',task);
      this.store.event(task.conversationId,{taskId:task.id,agentId:task.agentId??null,
        agentRunId:task.agentRunId??null,parentTaskId:task.parentId??task.continuationOf??null,type:'task',state});
      if(task.parentId) {
        const parent=this.store.get<Task>('tasks',task.parentId);
        if(parent)this.store.event(parent.conversationId,{taskId:parent.id,agentRunId:parent.agentRunId??null,
          childTaskId:task.id,type:'delegation',state});
      }
      if(task.continuationOf) {
        const parent=this.store.get<Task>('tasks',task.continuationOf);
        if(parent && parent.state==='waiting_children') {
          parent.state=state==='completed'?'completed':state==='cancelled'?'cancelled':'interrupted';
          parent.error=state==='completed'?null:'Child synthesis did not complete; reconcile before retrying.';
          // The parent result contains the synthesis, not an extra synthetic user turn.
          if(state==='completed'&&task.result&&!parent.result.includes(task.result))
            parent.result+=(parent.result?'\n\n':'')+task.result;
          // Use the completed synthesis attempt, not the accumulated transcript:
          // the pre-join answer and streamed continuation are not one JSON.
          if(parent.parentId&&parent.state==='completed')
            parent.handoff=agentHandoff(task.result);
          this.store.save('tasks',parent);
          this.store.event(parent.conversationId,{taskId:parent.id,agentId:parent.agentId??null,
            agentRunId:parent.agentRunId??null,type:'task',state:parent.state});
          if(parent.parentId) {
            const ancestor=this.store.get<Task>('tasks',parent.parentId);
            if(ancestor)this.store.event(ancestor.conversationId,{taskId:ancestor.id,
              agentRunId:ancestor.agentRunId??null,childTaskId:parent.id,type:'delegation',state:parent.state});
          }
        }
      }
    });
    if(['failed','cancelled','interrupted'].includes(state) && !task.continuationOf)
      for(const child of this.tasks().filter(t=>t.parentId===task.id&&!terminal(t.state)))
        void this.cancel(child.id);
    this.kick();
  }
  private async execute(task:Task,controller:AbortController,deps:Task[]) {
    let phase:HarnessPhase|'atlas_tool_discovery'|'pi_initialization'='atlas_tool_discovery';
    const timeout=setTimeout(()=>controller.abort(new Error('Execution time limit reached')),this.limits.maxRunMs);
    try {
      const joining=task.kind==='join'&&!!task.continuationOf;
      // Joins are inference-only; child text is untrusted and cannot introduce
      // new tool effects while we synthesise the outcome.
      let atlasAvailable=false;
      let tools:Awaited<ReturnType<Gateway['tools']>>=[];
      if(!joining&&this.gateway) {
        try { tools=await this.gateway.tools(task,controller.signal);atlasAvailable=true; }
        catch { controller.signal.throwIfAborted();atlasAvailable=false;tools=[]; }
      }
      const registryReadNames=new Set<string>();
      if(!joining && this.capabilities) {
        // An MCP tool is read-authorized because the server-side registry
        // admitted it, NOT because a tool name happens to start with mcp_.
        // Children receive only their exact delegated read-only subset.
        const discovered=await this.capabilities.tools(task,this.store,controller.signal,
          (...args)=>this.approve(...args));
        // Only read tools may become child-admissible by name. A root GitHub
        // write is explicitly not inheritable even when the root has consent.
        for(const tool of discovered)
          if(!['mcp_github_create_issue','mcp_github_add_issue_comment'].includes(tool.name))
            registryReadNames.add(tool.name);
        tools.push(...discovered);
      }
      const admitted=tools.filter(tool=>registryReadNames.has(tool.name) ||
        READ_TOOLS.has(tool.name.replace(/^atlas_/,''))).map(tool=>tool.name);
      if(task.parentId || task.delegation) {
        // Detached child retries are still children of the *capability*
        // policy even though they no longer join their previous parent.
        const allowed=new Set(task.delegation?.toolNames??[]);
        tools=tools.filter(tool=>allowed.has(tool.name)&&admitted.includes(tool.name));
      }
      const delegateModelKeys=this.modelRegistry?.models.map(model=>model.key)??[];
      // Accept a shorthand ONLY for the currently selected Ollama model.
      // It must be visible in the Pi tool schema as well as in admission,
      // otherwise Pi rejects the input before compatibility handling runs.
      const selectedOllamaId=task.modelKey?.startsWith('ollama/')
        ?task.modelKey.slice('ollama/'.length):null;
      if(selectedOllamaId && delegateModelKeys.includes(task.modelKey!))
        delegateModelKeys.push(selectedOllamaId);
      if(!joining)tools.push({
        name:'relay_delegate',label:'Delegate task',
        description:'Spawn a bounded independent child agent and return its durable task/run IDs. By default the child inherits the exact current model, including local Ollama/Qwen; omit modelKey unless changing models deliberately. The parent automatically waits and synthesises child results. External child tools must be explicitly admitted read-only capabilities.',
        parameters:Type.Object({
          prompt:Type.String({minLength:1,maxLength:6000}),
          dependencies:Type.Optional(Type.Array(Type.String(),{maxItems:8})),
          tools:Type.Optional(Type.Array(Type.String(),{maxItems:16})),
          context:Type.Optional(Type.String({maxLength:2000})),
          profile:Type.Optional(Type.Union([Type.Literal('general'),Type.Literal('researcher'),
            Type.Literal('reviewer'),Type.Literal('implementer')])),
          // The default is deliberately inheritance; constrain explicit
          // overrides to actual provider-qualified keys, not invented labels.
          ...(delegateModelKeys.length?{
            modelKey:Type.Optional(Type.Union(
              delegateModelKeys.map(key=>Type.Literal(key)),
              {description:'Optional. Omit to inherit the parent agent\'s model. Use an exact configured Relay key such as ollama/qwen3-coder:30b, or the current parent\'s exact Ollama ID as shorthand. Display names are not valid.'}
            ))
          }:{}),
          maxTokens:Type.Optional(Type.Integer({minimum:1,maximum:1000000})),
          maxCostUsd:Type.Optional(Type.Number({exclusiveMinimum:0,maximum:100}))
        }),
        execute:async (_id,input) => {
          const args=input as {prompt:string;dependencies?:string[];tools?:string[];context?:string;profile?:string;modelKey?:string;maxTokens?:number;maxCostUsd?:number};
          controller.signal.throwIfAborted();
          if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>6000)
            throw new Error('Invalid child task prompt');
          if(this.tasks().filter(child=>child.parentId===task.id).length>=4)
            throw new Error('Child task limit reached');
          let depth=0,ancestor:Task|undefined=task;
          while(ancestor?.parentId) {
            depth++;if(depth>=2)throw new Error('Delegation depth limit reached');
            ancestor=this.store.get<Task>('tasks',ancestor.parentId);
          }
          const existing=this.tasks();
          validateDependencies(existing,task.conversationId,args.dependencies??[],task.id);
          if(existing.filter(t=>!terminal(t.state)).length>=this.limits.queue)
            throw new Error('Task queue is full');
          if(args.modelKey!==undefined&&!this.modelRegistry)
            throw new Error('Delegated model is not permitted');
          const inheritedModel=task.modelKey??this.store.get<Conversation>('conversations',task.conversationId)?.modelKey??null;
          const policy=delegationPolicy(args,admitted,inheritedModel,
            this.modelRegistry?.models.map(m=>m.key)??null,task.delegation);
          this.budget(task.conversationId,task.id,policy);
          const conversation=this.conversation(policy.modelKey??undefined,task.conversationId);
          // Only the enqueue-time Atlas context is copied. There is no
          // inherited transcript, prior private chat or arbitrary MCP credential.
          conversation.atlasContext=task.atlasContext??null;
          this.store.save('conversations',conversation);
          let child:Task;
          try {
            child=this.enqueue(conversation.id,args.prompt,randomUUID(),args.dependencies??[],task.id,null,
              {delegation:policy,modelKey:policy.modelKey??undefined});
          } catch(error) {
            // A failed admission must not leave an empty hidden child chat.
            this.store.db.prepare('DELETE FROM conversations WHERE id=?').run(conversation.id);
            throw error;
          }
          return {content:[{type:'text' as const,text:JSON.stringify({
            taskId:child.id,agentId:child.agentId,agentRunId:child.agentRunId,
            state:child.state,conversationId:child.conversationId
          })}],details:{}};
        }
      });
      let length=0;
      phase='pi_initialization';
      const parent=joining?this.store.get<Task>('tasks',task.continuationOf!):undefined;
      if(joining && (!parent || parent.state!=='waiting_children' || parent.joinTaskId!==task.id))
        throw new Error('Join parent is not awaiting this continuation');
      const joinedChildren=parent?this.tasks().filter(child=>child.parentId===parent.id):[];
      if(parent && joinedChildren.some(child=>!terminal(child.state)))
        throw new Error('Child results are not yet terminal');
      const dependencyResults=[
        ...deps.map(d=>({id:d.id,state:d.state,result:d.result.slice(0,12000)})),
        ...(task.retryDependencyResults??[]).map(d=>({id:d.taskId,state:'completed',result:d.result}))
      ];
      const prompt=parent?
        handoffPrompt(parent,joinedChildren,this.tasks())+
        (parent.delegation?.profile&&parent.delegation.profile!=='general'
          ?profilePrompt(parent.delegation.profile):''):

        task.prompt+
        (task.delegation?.profile && task.delegation.profile!=='general'
          ?profilePrompt(task.delegation.profile):'')+
        (task.delegation?.context?'\n\nExplicit delegated context (untrusted):\n'+task.delegation.context:'')+
        (dependencyResults.length?'\n\nDependency results (untrusted data):\n'+JSON.stringify(dependencyResults):'');
      const result=await this.harness.run({version:1,atlasContext:task.atlasContext??null,atlasAvailable,
        modelKey:task.modelKey??this.store.get<Conversation>('conversations',task.conversationId)?.modelKey,
        task:{...task,prompt},signal:controller.signal,tools,
        onSkills:names=>{for(const name of names)this.store.event(task.conversationId,{
          taskId:task.id,agentRunId:task.agentRunId??null,agentId:task.agentId??null,
          type:'skill',state:'loaded',tool:name});},
        onSkippedSkills:names=>{for(const name of names)this.store.event(task.conversationId,{
          taskId:task.id,agentRunId:task.agentRunId??null,agentId:task.agentId??null,
          type:'skill',state:'skipped_context',tool:name});},
        onPhase:next=>{phase=next;this.store.event(task.conversationId,{taskId:task.id,
          agentId:task.agentId??null,agentRunId:task.agentRunId??null,type:'phase',state:next});},
        onText:text=>{
          length+=text.length;if(length>200000){controller.abort();return;}
          if(parent && this.store.get<Task>('tasks',parent.id)?.state!=='waiting_children') {
            controller.abort(new Error('Join parent is no longer waiting'));
            return;
          }
          if(parent && !task.result)parent.result+=(parent.result?'\n\n':'');
          task.result+=text;this.store.save('tasks',task);
          const target=parent??task;
          if(parent) {parent.result+=text;this.store.save('tasks',parent);}
          this.store.event(target.conversationId,{taskId:target.id,
            agentId:target.agentId??null,agentRunId:target.agentRunId??null,
            type:'delta',state:target.state,text,textOffset:target.result.length});
        },
        onUsage:usage=>{
          task.usage.push(usage);this.store.save('tasks',task);
          this.store.event(task.conversationId,{taskId:task.id,
            agentId:task.agentId??null,agentRunId:task.agentRunId??null,type:'usage',state:'recorded'});
          const own=used(task.usage),global=this.usage();
          const family=this.familyUsage(task.conversationId,task.parentId??task.continuationOf??null);
          // Always evaluate the shared subtree, even when this run's own
          // limit is exhausted. Short-circuiting on the per-run limit would
          // leave concurrently running siblings alive without new receipts.
          const treeExhausted=this.delegatedTreeExhausted(task.id,0,true);
          if((task.delegation?.maxTokens!=null&&(own.unknown||own.tokens>=task.delegation.maxTokens))||
            (task.delegation?.maxCostUsd!=null&&(own.unknown||own.usd>=task.delegation.maxCostUsd))||
            (this.limits.sessionTokens>0&&(family.unknown||family.tokens>=this.limits.sessionTokens))||
            (this.limits.sessionUsd>0&&(family.unknown||family.costUsd>=this.limits.sessionUsd))||
            (this.limits.globalUsd>0&&(global.unknown||global.costUsd>=this.limits.globalUsd))||
            treeExhausted)
            controller.abort(new Error('Budget limit reached'));
        }});
      task.result=result.slice(0,200000);
      const children=this.tasks().filter(child=>child.parentId===task.id);
      this.finish(task,controller.signal.aborted?'cancelled':children.length?'waiting_children':'completed');
    } catch(e) {
      if(controller.signal.aborted) this.finish(task,'cancelled','Execution cancelled or limit reached');
      else if(e instanceof LocalProviderUnavailableError) {
        this.finish(task,'failed',e.reason==='missing_model'?'Local Ollama model not installed. Check ollama list and the Relay model configuration. No inference started.':'Local Ollama unavailable. Start Ollama and reconnect Tailscale, then retry the request. No inference started.');
        console.warn('Relay local provider unavailable',{taskId:task.id,phase,reason:e.reason});
      } else if(e instanceof ProviderRateLimitError) {
        this.finish(task,'failed','OpenRouter rate limit reached (HTTP 429). Free-model quotas may be shared across models. Check OpenRouter usage and retry after the limit resets; reconcile any dispatched Atlas operation before retrying.');
        console.warn('Relay provider rate limited',{taskId:task.id,phase});
      } else {
        const type=e instanceof Error && ['TypeError','RangeError','SyntaxError','AbortError'].includes(e.name)?e.name:'Error';
        this.finish(task,'failed',`Execution failed during ${phase} (${type}). Check Relay configuration; reconcile any dispatched operation.`);
        console.error('Relay execution failure',{taskId:task.id,phase,errorType:type});
      }
    } finally { clearTimeout(timeout); }
  }
  async cancel(id:string) {
    const task=this.store.get<Task>('tasks',id);if(!task)throw new Error('Task not found');
    if(terminal(task.state))return task;
    const active=this.active.get(id);
    if(active)active.abort();else this.finish(task,'cancelled');
    if(task.joinTaskId) {
      const join=this.store.get<Task>('tasks',task.joinTaskId);
      if(join&&!terminal(join.state))await this.cancel(join.id);
    }
    for(const a of this.store.all<Approval>('approvals'))if(a.taskId===id&&a.state==='pending'){a.state='rejected';this.store.save('approvals',a);}
    return this.store.get<Task>('tasks',id)!;
  }
  retry(id:string,confirmed:boolean) {
    const old=this.store.get<Task>('tasks',id);if(old?.kind==='join')throw new Error('Retry the parent task after reconciliation');
    if(!old||!terminal(old.state)||old.state==='completed')throw new Error('Task cannot be retried');
    if(!confirmed)throw new Error('Explicit reconciliation confirmation is required before retrying');
    // A new conversation avoids replaying partially executed Pi tool effects.
    // Cross-conversation task IDs cannot be dependencies on the new task.
    // Capture only completed dependencies as bounded, immutable untrusted data.
    const snapshots=completedDependencyReceipts(old,new Map(this.tasks().map(t=>[t.id,t])));
    const source=this.store.get<Conversation>('conversations',old.conversationId);
    const conversation=this.conversation(old.modelKey??source?.modelKey);
    conversation.atlasContext=old.atlasContext??null;
    this.store.save('conversations',conversation);
    try {
      // Explicit reconciliation starts an independent root attempt. Never
      // reattach it to the original parent: its join may already be running
      // or terminal, and a late child would invalidate the frozen handoff.
      return this.enqueue(conversation.id,old.prompt,randomUUID(),[],null,old.id,
        {agentId:old.agentId,modelKey:old.modelKey,delegation:old.delegation,
          retryDependencyResults:snapshots,retryDetachedFromParentId:old.parentId??undefined});
    } catch(error) {
      // A failed retry admission must not leave an empty conversation.
      this.store.db.prepare('DELETE FROM conversations WHERE id=?').run(conversation.id);
      throw error;
    }
  }
  private async approve(task:Task,invocationId:string,tool:string,args:Record<string,unknown>,signal:AbortSignal) {
    const approval:Approval={id:randomUUID(),taskId:task.id,invocationId,tool,args,state:'pending'};
    this.store.save('approvals',approval);task.state='awaiting_approval';this.store.save('tasks',task);
    this.store.event(task.conversationId,{taskId:task.id,agentRunId:task.agentRunId??null,agentId:task.agentId??null,invocationId,type:'approval',tool,state:'pending'});
    try {
      while(true) {
        signal.throwIfAborted();
        const current=this.store.get<Approval>('approvals',approval.id)!;
        if(current.state!=='pending') {
          if(current.state==='rejected')throw new Error('Approval rejected');
          task.state='running';this.store.save('tasks',task);return;
        }
        await delay(200,undefined,{signal});
      }
    }catch(error){
      // Aborted/killed tasks must not leave an actionable approval in the UI.
      const current=this.store.get<Approval>('approvals',approval.id);
      if(current?.state==='pending'){
        current.state='rejected';
        this.store.save('approvals',current);
        this.store.event(task.conversationId,{taskId:task.id,agentId:task.agentId??null,
          agentRunId:task.agentRunId??null,invocationId,tool,type:'approval',state:'rejected'});
      }
      throw error;
    }
  }
  decide(id:string,approved:boolean) {
    const a=this.store.get<Approval>('approvals',id);if(!a||a.state!=='pending')throw new Error('Approval is no longer pending');
    const task=this.store.get<Task>('tasks',a.taskId)!;
    if(task.state!=='awaiting_approval')throw new Error('Task is not awaiting approval');
    a.state=approved?'approved':'rejected';this.store.save('approvals',a);
    this.store.event(task.conversationId,{taskId:task.id,agentId:task.agentId??null,
      agentRunId:task.agentRunId??null,invocationId:a.invocationId,type:'approval',tool:a.tool,state:a.state});
    return a;
  }
  async stop() { this.stopped=true;for(const c of this.active.values())c.abort();await Promise.allSettled(this.jobs); }
}
