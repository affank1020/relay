import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../src/platform.js';
import { Engine, type Limits } from '../src/engine.js';
import { Store, type Task, type Conversation } from '../src/store.js';
import { PiHarness, type Harness, type HarnessRequest } from '../src/harness.js';

const limits:Limits={concurrency:1,queue:64,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000};
const fixture=(run:(r:HarnessRequest)=>Promise<string>):Harness=>({
  version:1,capabilities:{persistence:true,cancellation:true,tools:true},run
});
async function until(check:()=>boolean) {
  const end=Date.now()+5000;
  while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for agent state');await delay(5);}
}

test('new runs retain logical identity across explicit retries; legacy tasks are not assigned invented IDs',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixture(async()=>{throw new Error('fixture failure');}),limits);
  try {
    const c=engine.conversation();
    const first=engine.enqueue(c.id,'fail','retry-run-001');
    await until(()=>engine.store.get<Task>('tasks',first.id)?.state==='failed');
    const next=engine.retry(first.id,true);
    assert.equal(first.agentId,next.agentId);
    assert.notEqual(first.agentRunId,next.agentRunId);
    assert.notEqual(first.id,first.agentRunId);
    assert.throws(()=>engine.retry(first.id,false),/reconciliation/);
    const legacy:Task={...first,id:crypto.randomUUID(),requestId:'legacy-001',agentId:undefined,agentRunId:undefined};
    store.save('tasks',legacy);
    assert.equal(store.get<Task>('tasks',legacy.id)?.agentRunId,undefined);
    assert.equal(store.events(c.id).at(-1)?.schemaVersion,2);
  }finally{await engine.stop();store.close();}
});

test('reconciled dependent root retry carries a bounded fulfilled snapshot into its new chat',async()=>{
  const store=new Store(':memory:');let fail=true;const prompts:string[]=[];
  const engine=new Engine(store,fixture(async request=>{
    prompts.push(request.task.prompt);
    if(request.task.prompt.startsWith('dependent')){
      if(fail){fail=false;throw new Error('expected test failure');}
      assert.match(request.task.prompt,/previous dependency result/);
      return 'retry succeeded';
    }
    return 'previous dependency result';
  }),limits);
  try{
    const c=engine.conversation(),first=engine.enqueue(c.id,'source','retry-dependent-001');
    const dependent=engine.enqueue(c.id,'dependent','retry-dependent-002',[first.id]);
    await until(()=>store.get<Task>('tasks',dependent.id)?.state==='failed');
    const retry=engine.retry(dependent.id,true);
    assert.notEqual(retry.conversationId,c.id);
    assert.deepEqual(retry.dependencies,[]);
    assert.deepEqual(retry.retryDependencyResults,[{taskId:first.id,result:'previous dependency result'}]);
    await until(()=>store.get<Task>('tasks',retry.id)?.state==='completed');
    assert.equal(store.get<Task>('tasks',retry.id)?.result,'retry succeeded');
    assert.deepEqual(store.get<Task>('tasks',dependent.id)?.dependencies,[first.id]);
  }finally{await engine.stop();store.close();}
});

test('retired child spend survives SQLite restart and does not retain deleted transcripts',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'relay-retired-child-'));
  const file=join(folder,'relay.sqlite');
  let store=new Store(file);
  try{
    const h=fixture(async()=> 'not executed');h.deleteConversationSessions=async()=>{};
    const engine=new Engine(store,h,{...limits,sessionUsd:0.3,reserveUsd:0.02});
    const parentChat=engine.conversation(),childChat=engine.conversation(undefined,parentChat.id);
    const now=new Date().toISOString();
    const parent:Task={id:crypto.randomUUID(),conversationId:parentChat.id,requestId:'root-record',
      prompt:'root private instructions',state:'completed',createdAt:now,parentId:null,dependencies:[],
      attemptOf:null,result:'answer',error:null,usage:[]};
    const child:Task={...parent,id:crypto.randomUUID(),conversationId:childChat.id,requestId:'child-record',
      prompt:'private child prompt',result:'private child result',parentId:parent.id,
      usage:[{input:8,output:0,cacheRead:0,cacheWrite:0,costUsd:0.29,costKind:'estimated'}]};
    store.save('tasks',parent);store.save('tasks',child);
    await engine.deleteConversation(childChat.id);
    assert.equal(store.retiredFamilyUsage(parentChat.id).tokens,8);
    store.close();
    store=new Store(file);
    const resumed=new Engine(store,h,{...limits,sessionUsd:0.3,reserveUsd:0.02});
    assert.equal(store.retiredFamilyUsage(parentChat.id).costUsd,0.29);
    assert.equal(store.retiredUsage().costUsd,0.29);
    assert.throws(()=>resumed.enqueue(parentChat.id,'next turn','retired-reopen-001'),/Inference budget/);
    const ledger=JSON.stringify(store.db.prepare('SELECT * FROM retired_family_usage').all());
    assert.doesNotMatch(ledger,/private child/);
    await resumed.stop();
  }finally{
    if(store.db.isOpen)store.close();
    await rm(folder,{recursive:true,force:true});
  }
});

test('parent subtree purge leaves durable tombstones for all hidden sessions if Pi cleanup fails',async()=>{
  const store=new Store(':memory:');
  const deletions:string[]=[];
  const harness=fixture(async()=> 'unused');
  harness.deleteConversationSessions=async id=>{deletions.push(id);throw new Error('simulated Pi cleanup failure');};
  const engine=new Engine(store,harness,limits);
  const now=new Date().toISOString();
  try{
    const root=engine.conversation(),childChat=engine.conversation(undefined,root.id);
    const parent:Task={id:crypto.randomUUID(),conversationId:root.id,requestId:'parent-cleanup',
      prompt:'root',state:'completed',createdAt:now,parentId:null,dependencies:[],attemptOf:null,
      result:'done',error:null,usage:[]};
    const child:Task={...parent,id:crypto.randomUUID(),conversationId:childChat.id,requestId:'child-cleanup',
      parentId:parent.id,prompt:'child',usage:[{input:1,output:0,cacheRead:0,cacheWrite:0,costUsd:.1,costKind:'estimated'}]};
    store.save('tasks',parent);store.save('tasks',child);
    await assert.rejects(engine.deleteConversation(root.id),/durable cleanup pending/);
    assert.equal(deletions.length,1);
    assert.equal(store.all<Conversation>('conversations').length,0);
    assert.equal(store.pendingSessionDeletions().length,2);
    assert.equal(store.retiredUsage().costUsd,.1);
    const repair=fixture(async()=> 'unused');
    repair.deleteConversationSessions=async id=>{deletions.push(id);};
    const resumed=new Engine(store,repair,limits);
    resumed.start();
    await until(()=>store.pendingSessionDeletions().length===0);
    assert.equal(new Set(deletions).size,2);
    await resumed.stop();
  }finally{await engine.stop();store.close();}
});

test('large sidebar history needs only one task-table scan and hides legacy internal sessions',async()=>{
  const store=new Store(':memory:');
  const now=new Date().toISOString();
  const roots:string[]=[];
  for(let i=0;i<450;i++){
    const conversationId=crypto.randomUUID(),taskId=crypto.randomUUID();
    roots.push(conversationId);
    store.save('conversations',{id:conversationId,title:'Chat '+i,createdAt:now});
    const root:Task={id:taskId,conversationId,requestId:'history-root-'+i,
      prompt:'task '+i,state:'completed',createdAt:now,parentId:null,dependencies:[],
      attemptOf:null,result:'done',error:null,usage:[]};
    store.save('tasks',root);
    if(i%3===0){
      const childId=crypto.randomUUID();
      store.save('conversations',{id:childId,title:'internal legacy',createdAt:now});
      store.save('tasks',{...root,id:crypto.randomUUID(),conversationId:childId,requestId:'child-'+i,parentId:taskId});
    }
  }
  const engine=new Engine(store,fixture(async()=> 'unused'),limits);
  const token='relay-large-sidebar-list-token-123';
  const server=createPlatform(engine,token,'.','cohere/north-mini-code:free');
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const originalAll=store.all.bind(store);
  let scans=0;
  store.all=((table:Parameters<Store['all']>[0])=>{
    if(table==='tasks')scans++;
    return originalAll(table);
  }) as Store['all'];
  try{
    const response=await fetch('http://127.0.0.1:'+address.port+'/api/sessions',
      {headers:{Authorization:'Bearer '+token}});
    assert.equal(response.status,200);
    const sessions=(await response.json() as {sessions:Array<{id:string;busy:boolean}>}).sessions;
    assert.equal(sessions.length,450);
    assert.ok(sessions.every(session=>roots.includes(session.id)&&session.busy===false));
    assert.equal(scans,1,'GET /sessions must decode the task table at most once, not once per chat');
    const index=store.db.prepare("PRAGMA index_list('tasks')").all() as Array<{name:string}>;
    assert.ok(index.some(i=>i.name==='task_internal_child_conversation'));
  }finally{
    store.all=originalAll;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();
  }
});
