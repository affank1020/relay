import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type State = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Conversation { id: string; title: string; createdAt: string; modelKey?: string; }
export interface Usage { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; costUsd: number | null; costKind: 'estimated' | 'measured' | 'unknown'; }
export interface Task { id: string; conversationId: string; requestId: string; prompt: string; state: State; createdAt: string; parentId: string | null; dependencies: string[]; attemptOf: string | null; result: string; error: string | null; usage: Usage[]; }
export interface ExecutionEvent {
  schemaVersion: 1; id: string; sequence: number; timestamp: string; conversationId: string;
  taskId: string | null; agentRunId: string | null; invocationId: string | null;
  type: string; state: string; tool: string | null; atlasOperationId: string | null;
  projectId: string | null; workspaceId: string | null; selectedNodeId: string | null;
  executingNodeId: string | null; text?: string;
}
export interface Approval { id: string; taskId: string; invocationId: string; tool: string; args: Record<string, unknown>; state: 'pending' | 'approved' | 'rejected'; }
export const terminal = (state: State) => ['completed','failed','cancelled','interrupted'].includes(state);
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('Database schema is newer than this Relay version');
    this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(conversation_id,request_id));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_replay ON events(conversation_id,sequence);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
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
  close() { this.db.close(); }
}
