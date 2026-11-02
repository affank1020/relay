import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AtlasContext } from './atlas-context.js';
import type { AtlasResourceObservation } from './atlas-awareness.js';

export type State = 'queued' | 'running' | 'awaiting_approval' | 'waiting_children' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface CodingWorktreeGrant {
  /** Proven by Atlas worktree creation and immediate live inspection. */
  id:string;baseId:string;nodeId:string;repository:string;branch:string;
}
export interface Conversation { id: string; title: string; createdAt: string; modelKey?: string; manualTitle?: boolean; atlasContext?: AtlasContext|null;
  /** Server-issued, per-conversation worktree provenance. Each new turn still requires write approval. */
  codingWorktrees?:CodingWorktreeGrant[];
  /** Internal Pi child session; never a user chat. Direct task URLs still permit inspection. */
  internalParentConversationId?: string;
}
export interface Usage { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; costUsd: number | null; costKind: 'estimated' | 'measured' | 'unknown'; }
export interface Task { id: string; conversationId: string; requestId: string; prompt: string; state: State; createdAt: string; parentId: string | null; dependencies: string[]; attemptOf: string | null; result: string; error: string | null; usage: Usage[]; atlasContext?: AtlasContext|null;
  /** Absent on legacy tasks, never fabricated during migration. */
  agentId?: string; agentRunId?: string; modelKey?: string; piSessionId?: string;
  delegation?: import('./orchestration.js').DelegationSnapshot;
  /** Bounded, untrusted model-authored report; never an execution receipt. */
  handoff?: import('./handoff.js').AgentHandoff;
  /** Pi extension owns execution; this task is a read-only durable projection. */
  kind?: 'agent' | 'join' | 'pi_subagent'; continuationOf?: string; joinTaskId?: string;
  /** Snapshot retained when a failed dependent task is retried in a new conversation. */
  retryDependencyResults?: import('./orchestration.js').DependencyReceipt[];
  /** A reconciled child retry is an independent run, never a late parent handoff. */
  retryDetachedFromParentId?: string;
}
export interface ExecutionEvent {
  schemaVersion: 1 | 2; id: string; sequence: number; timestamp: string; conversationId: string;
  taskId: string | null; agentRunId: string | null; invocationId: string | null;
  agentId?: string | null; parentTaskId?: string | null; childTaskId?: string | null;
  /** Schema-v1, bounded and allowlisted Atlas observation. */
  atlasResource?: AtlasResourceObservation;
  type: string; state: string; tool: string | null; atlasOperationId: string | null;
  projectId: string | null; workspaceId: string | null; selectedNodeId: string | null;
  executingNodeId: string | null; text?: string; textOffset?: number;
}
export interface Approval { id: string; taskId: string; invocationId: string; tool: string; args: Record<string, unknown>; state: 'pending' | 'approved' | 'rejected'; }
// Additive invocation metadata; older Atlas records intentionally lack kind.
// No schema migration or change to the persisted ExecutionEvent contract.
export interface InvocationRecord { id:string; state:string; kind?:string; invocationId?:string; toolName?:string; providerId?:string; [key:string]:unknown }

export const terminal = (state: State) => ['completed','failed','cancelled','interrupted'].includes(state);

export interface RetiredUsage { costUsd: number; tokens: number; unknown: boolean; measured: boolean; count: number; }

export class Store {
  readonly db: DatabaseSync;
  private readonly inMemory: boolean;
  // Notifications are hints, not the source of truth. A subscriber always
  // replays committed rows using their durable sequence cursor.
  private eventListeners=new Map<string,Set<()=>void>>();
  subscribeEvents(conversationId:string, listener:()=>void):()=>void {
    let listeners=this.eventListeners.get(conversationId);
    if(!listeners){listeners=new Set();this.eventListeners.set(conversationId,listeners);}
    listeners.add(listener);
    return ()=>{
      listeners!.delete(listener);
      if(!listeners!.size)this.eventListeners.delete(conversationId);
    };
  }
  constructor(path: string) {
    this.inMemory=path===':memory:';
    this.db = new DatabaseSync(path);
    // Overwrite freed cells on database pages, and separately truncate the
    // historical WAL frames below before reporting completed deletion.
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 3) throw new Error('Database schema is newer than this Relay version');
    // V1 -> V3 is additive. Migrate within one SQLite transaction; a failed
    // upgrade leaves the existing conversations and version intact.
    this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(conversation_id,request_id));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_replay ON events(conversation_id,sequence);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retired_usage(conversation_id TEXT PRIMARY KEY, cost_usd REAL NOT NULL, tokens INTEGER NOT NULL, unknown INTEGER NOT NULL, measured INTEGER NOT NULL, usage_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS retired_family_usage(conversation_id TEXT PRIMARY KEY, root_conversation_id TEXT NOT NULL, cost_usd REAL NOT NULL, tokens INTEGER NOT NULL, unknown INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS retired_family_root ON retired_family_usage(root_conversation_id);
      CREATE INDEX IF NOT EXISTS task_internal_child_conversation ON tasks(conversation_id) WHERE json_extract(data, '$.parentId') IS NOT NULL;
      CREATE TABLE IF NOT EXISTS retired_read_reconciliations(conversation_id TEXT PRIMARY KEY, read_count INTEGER NOT NULL CHECK(read_count>0), acknowledged_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_session_deletions(conversation_id TEXT PRIMARY KEY);
      PRAGMA user_version=3; COMMIT;`);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value=fn(); this.db.exec('COMMIT'); return value; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  all<T>(table: 'conversations'|'tasks'|'approvals'): T[] { return this.db.prepare('SELECT data FROM '+table+' ORDER BY rowid').all().map(r=>JSON.parse(String(r.data)) as T); }
  get<T>(table: 'conversations'|'tasks'|'approvals'|'invocations',id: string): T | undefined { const row=this.db.prepare('SELECT data FROM '+table+' WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) as T : undefined; }
  save<T extends {id:string}>(table: 'conversations'|'tasks'|'approvals'|'invocations', value:T): void {
    if(table==='tasks') { const t=value as unknown as Task; this.db.prepare('INSERT INTO tasks(id,conversation_id,request_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id,t.conversationId,t.requestId,JSON.stringify(t)); }
    else this.db.prepare('INSERT INTO '+table+'(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(value));
  }
  event(conversationId: string, fields: Partial<Omit<ExecutionEvent,'schemaVersion'|'id'|'sequence'|'timestamp'|'conversationId'>>): ExecutionEvent {
    const e: ExecutionEvent={schemaVersion:2,id:randomUUID(),sequence:0,timestamp:new Date().toISOString(),conversationId,taskId:null,agentRunId:null,invocationId:null,type:'task',state:'queued',tool:null,atlasOperationId:null,projectId:null,workspaceId:null,selectedNodeId:null,executingNodeId:null,...fields};
    const row=this.db.prepare('INSERT INTO events(id,conversation_id,data) VALUES(?,?,?)').run(e.id,conversationId,JSON.stringify(e));
    e.sequence=Number(row.lastInsertRowid);
    // The surrounding synchronous transaction (if any) finishes before this
    // microtask fires; rolled-back events cannot be replayed from SQLite.
    queueMicrotask(()=>{for(const listener of this.eventListeners.get(conversationId)??[])listener();});
    return e;
  }
  events(conversationId: string, after=0): ExecutionEvent[] {
    return this.db.prepare('SELECT sequence,data FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 500').all(conversationId,after).map(r=>({...JSON.parse(String(r.data)),sequence:Number(r.sequence)} as ExecutionEvent));
  }
  internalConversationIds():Set<string> {
    // Index-only scan of child conversations; no task JSON is parsed.
    return new Set(this.db.prepare(
      "SELECT DISTINCT conversation_id FROM tasks WHERE json_extract(data, '$.parentId') IS NOT NULL"
    ).all().map(row=>String(row.conversation_id)));
  }
  isInternalConversationId(conversationId:string):boolean {
    return !!this.db.prepare(
      "SELECT id FROM tasks WHERE conversation_id=? AND json_extract(data, '$.parentId') IS NOT NULL LIMIT 1"
    ).get(conversationId);
  }
  retiredUsage(): RetiredUsage {
    const row=this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens),0) AS tokens, COALESCE(MAX(unknown),0) AS unknown, COALESCE(MIN(measured),1) AS measured, COALESCE(SUM(usage_count),0) AS count FROM retired_usage').get() as {cost:number;tokens:number;unknown:number;measured:number;count:number};
    return {costUsd:row.cost,tokens:row.tokens,unknown:row.unknown!==0,measured:row.measured!==0,count:row.count};
  }
  retiredFamilyUsage(rootConversationId:string): Pick<RetiredUsage,'costUsd'|'tokens'|'unknown'> {
    const row=this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens),0) AS tokens, COALESCE(MAX(unknown),0) AS unknown FROM retired_family_usage WHERE root_conversation_id=?')
      .get(rootConversationId) as {cost:number;tokens:number;unknown:number};
    return {costUsd:row.cost,tokens:row.tokens,unknown:row.unknown!==0};
  }
  invocationRecords(taskId:string):InvocationRecord[] {
    return this.db.prepare('SELECT data FROM invocations WHERE substr(id,1,?)=?').all(taskId.length+1,taskId+':')
      .map(row=>JSON.parse(String(row.data)) as InvocationRecord);
  }
  invocationStates(taskId:string):string[] {
    return this.invocationRecords(taskId).map(record=>record.state??'unknown');
  }
  pendingSessionDeletions(): string[] {
    return this.db.prepare('SELECT conversation_id FROM pending_session_deletions ORDER BY conversation_id').all().map(row=>String(row.conversation_id));
  }
  sessionDeletionComplete(id:string):void {
    this.db.prepare('DELETE FROM pending_session_deletions WHERE conversation_id=?').run(id);
  }
  checkpointDeletedHistory():void {
    // DELETE does not remove older page images from an open SQLite WAL.
    // Only retire the cleanup tombstone after a verified TRUNCATE checkpoint.
    const result=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      {busy:number;log:number;checkpointed:number}|undefined;
    // In-memory SQLite has no WAL file: the pragma returns -1/-1.
    if(!result || result.busy!==0 || (this.inMemory
      ? result.log!==-1 || result.checkpointed!==-1
      : result.log!==0 || result.checkpointed!==0)) {
      throw new Error('Deleted conversation WAL cleanup is pending');
    }
  }
  // Caller validates all task states, cross-conversation references and
  // invocation uncertainty first. A full descendant tree is retired in one
  // transaction, so no partial deletion can strand a hidden child session.
  purgeConversations(entries: Array<{id:string;tasks:Task[];rootConversationId:string}>):void {
    if(!entries.length || new Set(entries.map(entry=>entry.id)).size!==entries.length)
      throw new Error('Invalid conversation purge');
    this.transaction(()=>{
      const deleteApproval=this.db.prepare('DELETE FROM approvals WHERE id=?');
      const deleteInvocation=this.db.prepare('DELETE FROM invocations WHERE substr(id,1,?)=?');
      for(const {id,tasks,rootConversationId} of entries) {
        const usage=tasks.flatMap(t=>t.usage);
        const cost=usage.reduce((sum,u)=>sum+(u.costUsd??0),0);
        const tokens=usage.reduce((sum,u)=>sum+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),0);
        const unknown=usage.some(u=>u.costUsd===null||u.input===null||u.output===null)?1:0;
        const measured=usage.every(u=>u.costKind==='measured')?1:0;
        this.db.prepare('INSERT INTO retired_usage(conversation_id,cost_usd,tokens,unknown,measured,usage_count) VALUES(?,?,?,?,?,?)')
          .run(id,cost,tokens,unknown,measured,usage.length);
        if(rootConversationId!==id)this.db.prepare('INSERT INTO retired_family_usage(conversation_id,root_conversation_id,cost_usd,tokens,unknown) VALUES(?,?,?,?,?)')
          .run(id,rootConversationId,cost,tokens,unknown);
        else this.db.prepare('DELETE FROM retired_family_usage WHERE root_conversation_id=?').run(id);
        const ids=new Set(tasks.map(t=>t.id));
        for(const approval of this.all<Approval>('approvals'))if(ids.has(approval.taskId))deleteApproval.run(approval.id);
        // Retain only numeric evidence of explicit MCP read reconciliation.
        // Raw invocation arguments, headers and results are still purged.
        const acknowledged=tasks.flatMap(t=>this.invocationRecords(t.id))
          .filter(r=>r.kind==='mcp_read'&&r.state==='reconciled_read');
        if(acknowledged.length){
          const acknowledgedAt=acknowledged.map(r=>typeof r.reconciledAt==='string'?r.reconciledAt:'')
            .sort().at(-1)||new Date().toISOString();
          this.db.prepare('INSERT INTO retired_read_reconciliations(conversation_id,read_count,acknowledged_at) VALUES(?,?,?)')
            .run(id,acknowledged.length,acknowledgedAt);
        }
        for(const task of tasks)deleteInvocation.run(task.id.length+1,task.id+':');
        this.db.prepare('DELETE FROM events WHERE conversation_id=?').run(id);
        this.db.prepare('DELETE FROM tasks WHERE conversation_id=?').run(id);
        if(this.db.prepare('DELETE FROM conversations WHERE id=?').run(id).changes!==1)
          throw new Error('Conversation not found');
        // A crash or filesystem failure cannot resurrect any deleted session.
        this.db.prepare('INSERT INTO pending_session_deletions(conversation_id) VALUES(?)').run(id);
      }
    });
    for(const {id} of entries)
      queueMicrotask(()=>{for(const listener of this.eventListeners.get(id)??[])listener();});
  }
  purgeConversation(id:string,tasks:Task[],rootConversationId:string=id):void {
    this.purgeConversations([{id,tasks,rootConversationId}]);
  }
  close() { this.eventListeners.clear(); this.db.close(); }
}
