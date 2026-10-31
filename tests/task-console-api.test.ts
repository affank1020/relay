import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Engine } from '../src/engine.js';
import { taskConsoleDetail, taskConsolePage, taskConsoleStates } from '../src/task-console-api.js';
import { Store, type Task, type Conversation, type Approval } from '../src/store.js';

function fixtures() {
  const store=new Store(':memory:');
  const conversations=[randomUUID(),randomUUID()];
  for(const id of conversations)store.save('conversations',{id,title:'Conversation '+id.slice(0,6),createdAt:new Date().toISOString()} as Conversation);
  const all:Task[]=[];
  for(let i=0;i<240;i++) {
    const task:Task={
      id:randomUUID(),conversationId:conversations[i%2],requestId:randomUUID(),
      prompt:'Task '+i,state:i%4===0?'failed':i%4===1?'running':i%4===2?'completed':'queued',
      createdAt:new Date(1700000000000+i*1000).toISOString(),
      parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]
    };
    store.save('tasks',task);all.push(task);
  }
  return {store,engine:{store} as Engine,conversations,all};
}
const query=(params='')=>new URL('http://localhost/api/task-console/tasks'+params);

test('task console paginates stable persisted rows beyond legacy 200-task cap',()=>{
  const {store,engine,all}=fixtures();
  try {
    const first=taskConsolePage(engine,query('?limit=50'));
    assert.equal(first.tasks.length,50);
    assert.equal(first.hasMore,true);
    assert.deepEqual(first.tasks.map(task=>task.id),all.slice(-50).reverse().map(task=>task.id));
    let cursor=first.nextCursor;
    const seen=new Set(first.tasks.map(task=>task.id));
    for(let i=0;i<4;i++) {
      const page=taskConsolePage(engine,query('?limit=50&cursor='+cursor));
      for(const task of page.tasks)assert.equal(seen.has(task.id),false,'a row must not appear in two pages');
      for(const task of page.tasks)seen.add(task.id);
      cursor=page.nextCursor;
      if(i===3) {assert.equal(page.hasMore,false);assert.equal(cursor,null);}
    }
    assert.equal(seen.size,240);
    assert.equal(first.counts.running,60);
    assert.equal(first.counts.failed,60);
  } finally {store.close();}
});

test('task console validates filters and counts all states within the selected conversation',()=>{
  const {store,engine,conversations}=fixtures();
  try {
    const filtered=taskConsolePage(engine,query('?conversationId='+conversations[0]+'&state=failed&limit=15'));
    assert.equal(filtered.tasks.length,15);
    assert.ok(filtered.tasks.every(task=>task.conversationId===conversations[0]&&task.state==='failed'));
    assert.equal(filtered.counts.failed,60);
    assert.equal(filtered.counts.completed,60);
    assert.equal(filtered.counts.running,undefined);
    for(const raw of ['?limit=0','?limit=101','?cursor=-1','?cursor=1.5','?state=bogus','?conversationId=x%27%20OR%201%3D1']) {
      assert.throws(()=>taskConsolePage(engine,query(raw)),/Invalid /,raw);
    }
  } finally {store.close();}
});

test('task detail returns relationships and a redacted approval preview without mutating persistence',()=>{
  const {store,engine,all}=fixtures();
  try {
    const task=all[20],child=all[21];
    child.parentId=task.id;store.save('tasks',child);
    store.save('approvals',{
      id:randomUUID(),taskId:task.id,invocationId:randomUUID(),tool:'atlas_operation',
      args:{projectId:'legitimate',apiToken:'plain-secret',nested:{password:'private',input:'safe'}},
      state:'pending'
    } as Approval);
    const detail=taskConsoleDetail(engine,task.id);
    assert.ok(detail);
    assert.equal(detail.children[0].id,child.id);
    assert.equal(detail.approvals.length,1);
    assert.equal((detail.approvals[0].args as {apiToken:string}).apiToken,'[redacted]');
    assert.equal(((detail.approvals[0].args as {nested:{password:string}}).nested).password,'[redacted]');
    assert.equal((store.all<{args:{apiToken:string}}>('approvals')[0].args.apiToken),'plain-secret','read projection must not modify the actual approval');
    assert.equal(taskConsoleDetail(engine,randomUUID()),null);
  } finally {store.close();}
});


test('bounded state reconciliation reveals only task state and conversation scope',()=>{
  const {store,engine,all}=fixtures();
  try {
    const first=all[0],second=all[1],missing=randomUUID();
    first.state='running';
    first.result='internal model output must not be transmitted';
    first.error='private error details';
    store.save('tasks',first);
    const url=new URL('http://localhost/api/task-console/task-states?ids='+[first.id,second.id,missing].join(','));
    const result=taskConsoleStates(engine,url);
    assert.deepEqual(Object.keys(result.states).sort(),[first.id,second.id].sort());
    assert.deepEqual(result.states[first.id],{state:'running',conversationId:first.conversationId});
    assert.ok(!JSON.stringify(result).includes(first.result));
    assert.ok(!JSON.stringify(result).includes(first.error));
    for(const invalid of ['', '?ids=x', '?ids='+first.id+','+first.id, '?ids='+Array.from({length:51},()=>randomUUID()).join(',')]) {
      const query=new URL('http://localhost/api/task-console/task-states'+invalid);
      assert.throws(()=>taskConsoleStates(engine,query),/Invalid task state IDs/,invalid);
    }
  } finally {store.close();}
});
