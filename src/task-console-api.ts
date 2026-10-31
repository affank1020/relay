import type { Engine } from './engine.js';
import type { Approval, Conversation, State, Task } from './store.js';

const states = new Set<State>(['queued','running','awaiting_approval','completed','failed','cancelled','interrupted']);
const conversationId = /^[a-f0-9-]{1,80}$/;

function params(url: URL) {
  const limitRaw=url.searchParams.get('limit')??'50';
  const cursorRaw=url.searchParams.get('cursor');
  const state=url.searchParams.get('state');
  const conversation=url.searchParams.get('conversationId');
  if(!/^\d+$/.test(limitRaw)||Number(limitRaw)<1||Number(limitRaw)>100)throw new Error('Invalid task page limit');
  if(cursorRaw!==null&&(!/^[1-9]\d*$/.test(cursorRaw)||!Number.isSafeInteger(Number(cursorRaw))))throw new Error('Invalid task cursor');
  if(state&&state!=='all'&&!states.has(state as State))throw new Error('Invalid task state');
  if(conversation&&!conversationId.test(conversation))throw new Error('Invalid conversation filter');
  return {limit:Number(limitRaw),cursor:cursorRaw===null?null:Number(cursorRaw),state:state&&state!=='all'?state:null,conversation};
}

export function taskConsolePage(engine:Engine,url:URL) {
  const {limit,cursor,state,conversation}=params(url);
  const clauses:string[]=[];
  const values:(string|number)[]=[];
  if(conversation){clauses.push('conversation_id=?');values.push(conversation);}
  const counts=engine.store.db.prepare('SELECT json_extract(data, \x27$.state\x27) AS state, COUNT(*) AS total FROM tasks'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' GROUP BY state').all(...values) as {state:string;total:number}[];
  if(cursor!==null){clauses.push('rowid<?');values.push(cursor);}
  if(state){clauses.push('json_extract(data, \x27$.state\x27)=?');values.push(state);}
  const sql='SELECT rowid, data FROM tasks'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY rowid DESC LIMIT ?';
  const rows=engine.store.db.prepare(sql).all(...values,limit+1) as {rowid:number;data:string}[];
  const more=rows.length>limit;
  const page=rows.slice(0,limit);
  return {
    tasks:page.map(row=>JSON.parse(row.data) as Task),
    nextCursor:more?String(page[page.length-1].rowid):null,
    hasMore:more,
    counts:Object.fromEntries(counts.map(row=>[row.state,row.total]))
  };
}

// Approvals can contain tool arguments. Display only an allowlisted, bounded,
// recursively redacted preview, never arbitrary headers or authentication material.
function safeArgs(value:unknown,depth=0):unknown {
  if(depth>=4)return '[truncated]';
  if(Array.isArray(value))return value.slice(0,12).map(item=>safeArgs(item,depth+1));
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value).slice(0,20).map(([key,item])=>[
      key,/token|secret|password|credential|authorization|api.?key|headers|cookie|private.?key/i.test(key)?'[redacted]':safeArgs(item,depth+1)
    ]));
  }
  if(typeof value==='string')return value.slice(0,350);
  return typeof value==='number'||typeof value==='boolean'||value===null?value:'[unavailable]';
}

export function taskConsoleDetail(engine:Engine,id:string) {
  const task=engine.store.get<Task>('tasks',id);
  if(!task)return null;
  const conversation=engine.store.get<Conversation>('conversations',task.conversationId);
  const approvals=engine.store.all<Approval>('approvals')
    .filter(approval=>approval.taskId===id)
    .map(({id,tool,state,args})=>({id,tool,state,args:safeArgs(args)}));
  const children=engine.store.db.prepare("SELECT data FROM tasks WHERE json_extract(data, '$.parentId')=? ORDER BY rowid DESC LIMIT 20")
    .all(id).map(row=>JSON.parse(String(row.data)) as Task);
  return {task,conversation:conversation?{id:conversation.id,title:conversation.title,modelKey:conversation.modelKey??null}:null,approvals,children};
}
