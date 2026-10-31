import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AtlasContext } from './atlas-context.js';

export type State = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Conversation { id: string; title: string; createdAt: string; modelKey?: string; manualTitle?: boolean; atlasContext?: AtlasContext|null; }
export interface Usage { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; costUsd: number | null; costKind: 'estimated' | 'measured' | 'unknown'; }
export interface Task { id: string; conversationId: string; requestId: string; prompt: string; state: State; createdAt: string; parentId: string | null; dependencies: string[]; attemptOf: string | null; result: string; error: string | null; usage: Usage[]; atlasContext?: AtlasContext|null; }
export interface ExecutionEvent {
  schemaVersion: 1; id: string; sequence: number; timestamp: string; conversationId: string;
  taskId: string | null; agentRunId: string | null; invocationId: string | null;
  type: string; state: string; tool: string | null; atlasOperationId: string | null;
  projectId: string | null; workspaceId: string | null; selectedNodeId: string | null;
  executingNodeId: string | null; text?: string;
}
export interface Approval { id: string; taskId: string; invocationId: string; tool: string; args: Record<string, unknown>; state: 'pending' | 'approved' | 'rejected'; }
export const terminal = (state: State) => ['completed','failed','cancelled','interrupted'].includes(state);

export interface RetiredUsage { costUsd: number; tokens: number; unknown: boolean; measured: boolean; count: number; }

export class Store {
  readonly db: DatabaseSync;
  private readonly inMemory: boolean;
  constructor(path: string) {
    this.inMemory=path===':memory:';
    this.db = new DatabaseSync(path);
    // Overwrite freed cells on database pages, and separately truncate the
    // historical WAL frames below before reporting completed deletion.
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 2) throw new Error('Database schema is newer than this Relay version');
    // V1 -> V2 is additive. Migrate within one SQLite transaction; a failed
    // upgrade leaves the existing conversations and version intact.
    this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(conversation_id,request_id));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_replay ON events(conversation_id,sequence);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retired_usage(conversation_id TEXT PRIMARY KEY, cost_usd REAL NOT NULL, tokens INTEGER NOT NULL, unknown INTEGER NOT NULL, measured INTEGER NOT NULL, usage_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_session_deletions(conversation_id TEXT PRIMARY KEY);
      PRAGMA user_version=2; COMMIT;`);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value=fn(); this.db.exec('COMMIT'); return value; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  all<T>(table: 'conversations'|'tasks'|'approvals'): T[] { return this.db.prepare('SELECT data FROM '+table+' ORDER BY rowid').all().map(r=>JSON.parse(String(r.data)) as T); }
  get<T>(table: 'conversations'|'tasks'|'approvals'|'invocations',id: string): T | undefined { const row=this.db.prepare('SELECT data FROM '+table+' WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) as T : undefined; }
  save(table: 'conversations'|'tasks'|'approvals'|'invocations', value: {id: string}): void {
    if(table==='tasks') { const t=value as Task; this.db.prepare('INSERT INTO tasks(id,conversation_id,request_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id,t.conversationId,t.requestId,JSON.stringify(t)); }
    else this.db.prepare('INSERT INTO '+table+'(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(value));
  }
  event(conversationId: string, fields: Partial<Omit<ExecutionEvent,'schemaVersion'|'id'|'sequence'|'timestamp'|'conversationId'>>): ExecutionEvent {
    const e: ExecutionEvent={schemaVersion:1,id:randomUUID(),sequence:0,timestamp:new Date().toISOString(),conversationId,taskId:null,agentRunId:null,invocationId:null,type:'task',state:'queued',tool:null,atlasOperationId:null,projectId:null,workspaceId:null,selectedNodeId:null,executingNodeId:null,...fields};
    const row=this.db.prepare('INSERT INTO events(id,conversation_id,data) VALUES(?,?,?)').run(e.id,conversationId,JSON.stringify(e));
    e.sequence=Number(row.lastInsertRowid); return e;
  }
  events(conversationId: string, after=0): ExecutionEvent[] {
    return this.db.prepare('SELECT sequence,data FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 500').all(conversationId,after).map(r=>({...JSON.parse(String(r.data)),sequence:Number(r.sequence)} as ExecutionEvent));
  }
  retiredUsage(): RetiredUsage {
    const row=this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens),0) AS tokens, COALESCE(MAX(unknown),0) AS unknown, COALESCE(MIN(measured),1) AS measured, COALESCE(SUM(usage_count),0) AS count FROM retired_usage').get() as {cost:number;tokens:number;unknown:number;measured:number;count:number};
    return {costUsd:row.cost,tokens:row.tokens,unknown:row.unknown!==0,measured:row.measured!==0,count:row.count};
  }
  invocationStates(taskId:string): string[] {
    return this.db.prepare('SELECT data FROM invocations WHERE substr(id,1,?)=?').all(taskId.length+1,taskId+':')
      .map(row=>(JSON.parse(String(row.data)) as {state?:string}).state??'unknown');
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
  // Caller verifies execution states and cross-conversation references first.
  // This entire purge and budget retirement is one durable SQLite transaction;
  // no message, result, tool args or transcript is copied into the usage ledger.
  purgeConversation(id:string,tasks:Task[]):void {
    this.transaction(()=>{
      const usage=tasks.flatMap(t=>t.usage);
      const cost=usage.reduce((sum,u)=>sum+(u.costUsd??0),0);
      const tokens=usage.reduce((sum,u)=>sum+(u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0),0);
      const unknown=usage.some(u=>u.costUsd===null||u.input===null||u.output===null)?1:0;
      const measured=usage.every(u=>u.costKind==='measured')?1:0;
      this.db.prepare('INSERT INTO retired_usage(conversation_id,cost_usd,tokens,unknown,measured,usage_count) VALUES(?,?,?,?,?,?)').run(id,cost,tokens,unknown,measured,usage.length);
      const deleteApproval=this.db.prepare('DELETE FROM approvals WHERE id=?');
      const ids=new Set(tasks.map(t=>t.id));
      for(const approval of this.all<Approval>('approvals'))if(ids.has(approval.taskId))deleteApproval.run(approval.id);
      // Invocation IDs are taskId + ":" + Pi call ID (including nested
      // discovery/placement calls). Never leave sensitive tool args/results.
      const deleteInvocation=this.db.prepare('DELETE FROM invocations WHERE substr(id,1,?)=?');
      for(const task of tasks)deleteInvocation.run(task.id.length+1,task.id+':');
      this.db.prepare('DELETE FROM events WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE conversation_id=?').run(id);
      const deleted=this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      if(deleted.changes!==1)throw new Error('Conversation not found');
      // A tombstone survives even a filesystem cleanup failure or process
      // crash; start() retries deletion without resurrecting the chat.
      this.db.prepare('INSERT INTO pending_session_deletions(conversation_id) VALUES(?)').run(id);
    });
  }
  close() { this.db.close(); }
}
