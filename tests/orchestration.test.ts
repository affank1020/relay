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
async function delegate(request:HarnessRequest,prompt:string,more:Record<string,unknown>={}) {
  const tool=request.tools.find(tool=>tool.name==='relay_delegate');
  assert.ok(tool,'delegation must be an admitted Pi tool');
  return await tool.execute('delegation-'+prompt,{prompt,...more},request.signal,undefined,{} as never);
}

test('one worker fan-out/fan-in persists distinct agent runs and synthesises without a manual conversation',async()=>{
  const store=new Store(':memory:');
  const executed:string[]=[];
  const engine=new Engine(store,fixture(async request=>{
    executed.push(request.task.kind==='join'?'join':request.task.prompt);
    if(request.task.prompt==='Parent request') {
      await delegate(request,'research A');
      await delegate(request,'research B');
      return 'I delegated research.';
    }
    if(request.task.kind==='join'){
      assert.deepEqual(request.tools,[],'join must have no external tools');
      assert.match(request.task.prompt,/research A/);
      assert.match(request.task.prompt,/research B/);
      assert.match(request.task.prompt,/result A/);
      assert.match(request.task.prompt,/result B/);
      return 'Final answer synthesised from both subagents.';
    }
    return request.task.prompt==='research A'?'result A':'result B';
  }),limits);
  try{
    const c=engine.conversation();
    const parent=engine.enqueue(c.id,'Parent request','fanout-001');
    await until(()=>engine.store.get<Task>('tasks',parent.id)?.state==='completed');
    const all=engine.tasks(),children=all.filter(t=>t.parentId===parent.id);
    const join=all.find(t=>t.continuationOf===parent.id)!;
    assert.equal(children.length,2);
    assert.ok(join);
    assert.equal(join.state,'completed');
    assert.equal(join.agentId,parent.agentId,'join continues the logical parent agent');
    assert.notEqual(join.agentRunId,parent.agentRunId,'join is a new run');
    for(const child of children) {
      assert.notEqual(child.id,child.agentRunId);
      assert.notEqual(child.agentId,parent.agentId);
      assert.equal(child.state,'completed');
      assert.deepEqual(child.delegation?.toolNames,[]);
    }
    assert.equal(new Set(all.map(t=>t.agentRunId)).size,4);
    assert.deepEqual(executed,['Parent request','research A','research B','join']);
    assert.match(engine.store.get<Task>('tasks',parent.id)!.result,/Final answer synthesised/);
    const timeline=store.events(c.id).filter(e=>e.type==='delegation');
    assert.equal(timeline.filter(e=>e.state==='queued').length,2);
    assert.equal(timeline.filter(e=>e.state==='completed').length,2);
    assert.ok(timeline.every(e=>e.schemaVersion===2 && e.childTaskId));
  }finally{await engine.stop();store.close();}
});

test('children receive no Atlas capabilities by default; explicit admitted reads only',async()=>{
  const store=new Store(':memory:');
  const atlas={list:async()=>[
    {name:'get_atlas_status',inputSchema:{type:'object'}},
    {name:'workspace_run_dev_task',inputSchema:{type:'object'}}
  ],call:async()=>({structuredContent:{result:{ok:true}}}),close:async()=>{}};
  const seen:string[][]=[];
  const engine=new Engine(store,fixture(async request=>{
    if(request.task.prompt==='root') {
      await delegate(request,'private-free');
      await delegate(request,'read-only',{tools:['atlas_get_atlas_status']});
      await assert.rejects(delegate(request,'mutation',{tools:['atlas_workspace_run_dev_task']}),/read-only/);
      return 'delegated';
    }
    if(request.task.kind==='join')return 'done';
    seen.push(request.tools.map(t=>t.name));
    return 'child done';
  }),{...limits,concurrency:2},atlas,{'test-checkout':['verify']});
  try{
    const c=engine.conversation();const parent=engine.enqueue(c.id,'root','admission-001');
    await until(()=>engine.store.get<Task>('tasks',parent.id)?.state==='completed');
    assert.deepEqual(seen,[['relay_delegate'],['atlas_get_atlas_status','relay_delegate']]);
    assert.equal(engine.tasks().filter(t=>t.parentId===parent.id).length,2);
  }finally{await engine.stop();store.close();}
});

test('dependency references are limited to the conversation or direct siblings',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixture(async request=>{
    if(request.task.prompt==='root'){
      const first=await delegate(request,'first child');
      const id=JSON.parse((first.content[0] as {text:string}).text).taskId as string;
      await delegate(request,'second child',{dependencies:[id]});
      await assert.rejects(delegate(request,'bad child',{dependencies:['00000000-0000-4000-8000-000000000000']}),/cross-scope/);
      return 'delegating';
    }
    if(request.task.kind==='join')return 'combined';
    return 'done';
  }),limits);
  try{
    const c=engine.conversation(),other=engine.conversation();
    const foreign=engine.enqueue(other.id,'other','other-task-001');
    assert.throws(()=>engine.enqueue(c.id,'cross-chat','cross-task-001',[foreign.id]),/cross-scope/);
    const parent=engine.enqueue(c.id,'root','scoped-001');
    await until(()=>engine.store.get<Task>('tasks',parent.id)?.state==='completed');
    const children=engine.tasks().filter(t=>t.parentId===parent.id);
    assert.equal(children.length,2);
    assert.deepEqual(children[1].dependencies,[children[0].id]);
  }finally{await engine.stop();store.close();}
});

test('waiting parents can be cancelled, cancelling queued and active child work without a join',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixture(async request=>{
    if(request.task.prompt==='root'){
      await delegate(request,'slow child');
      return 'started';
    }
    if(request.task.prompt==='slow child'){
      await delay(5000,undefined,{signal:request.signal});
      return 'unexpected';
    }
    return 'unexpected join';
  }),limits);
  try{
    const c=engine.conversation();const parent=engine.enqueue(c.id,'root','cancel-001');
    await until(()=>engine.store.get<Task>('tasks',parent.id)?.state==='waiting_children');
    await engine.cancel(parent.id);
    await until(()=>engine.tasks().every(task=>['cancelled','failed'].includes(task.state)));
    assert.equal(engine.tasks().some(task=>task.kind==='join'),false);
  }finally{await engine.stop();store.close();}
});

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

test('deleting completed child chats cannot discard pending parent handoffs',async()=>{
  const store=new Store(':memory:');
  let releaseSecond!:()=>void;
  const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;});
  const harness=fixture(async request=>{
    if(request.task.prompt==='root'){
      await delegate(request,'first child');
      await delegate(request,'second child');
      return 'started';
    }
    if(request.task.prompt==='second child')await secondGate;
    if(request.task.kind==='join'){
      assert.match(request.task.prompt,/first result/);
      assert.match(request.task.prompt,/second result/);
      return 'combined';
    }
    return request.task.prompt==='first child'?'first result':'second result';
  });
  harness.deleteConversationSessions=async()=>{};
  const engine=new Engine(store,harness,limits);
  try{
    const conversation=engine.conversation(),parent=engine.enqueue(conversation.id,'root','child-delete-001');
    await until(()=>engine.tasks().some(t=>t.parentId===parent.id&&t.prompt==='first child'&&t.state==='completed')
      && engine.tasks().some(t=>t.parentId===parent.id&&t.prompt==='second child'&&t.state==='running')
      && engine.store.get<Task>('tasks',parent.id)?.state==='waiting_children');
    const first=engine.tasks().find(t=>t.parentId===parent.id&&t.prompt==='first child')!;
    await assert.rejects(engine.deleteConversation(first.conversationId),/Child results are still needed/);
    assert.ok(store.get<Task>('tasks',first.id));
    releaseSecond();
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    assert.match(store.get<Task>('tasks',parent.id)!.result,/combined/);
  }finally{releaseSecond();await engine.stop();store.close();}
});

test('a lone completed child cannot be deleted before its pending join',async()=>{
  const store=new Store(':memory:');
  const harness=fixture(async()=> 'done');harness.deleteConversationSessions=async()=>{};
  const engine=new Engine(store,harness,limits);
  try{
    const main=engine.conversation(),childChat=engine.conversation();
    const parent:Task={id:crypto.randomUUID(),conversationId:main.id,requestId:'parent-fixture',prompt:'parent',
      state:'waiting_children',createdAt:new Date().toISOString(),parentId:null,dependencies:[],
      attemptOf:null,result:'',error:null,usage:[]};
    const child:Task={...parent,id:crypto.randomUUID(),conversationId:childChat.id,requestId:'child-fixture',
      parentId:parent.id,prompt:'child',state:'completed',result:'important research'};
    store.save('tasks',parent);store.save('tasks',child);
    await assert.rejects(engine.deleteConversation(childChat.id),/Child results are still needed/);
    assert.equal(store.get<Task>('tasks',child.id)?.result,'important research');
    engine.start();
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
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

test('family caps include earlier root turns, child joins, and per-family reservations',async()=>{
  const store=new Store(':memory:');
  const usage=(input:number,costUsd:number)=>({input,output:0,cacheRead:0,cacheWrite:0,costUsd,costKind:'estimated' as const});
  const engine=new Engine(store,fixture(async request=>{
    if(request.task.prompt==='later parent'){
      await delegate(request,'budgeted child');
      return 'started';
    }
    if(request.task.prompt==='budgeted child'){
      request.onUsage(usage(4,0.4));
      request.signal.throwIfAborted();
      return 'should abort';
    }
    if(request.task.kind==='join')return 'join';
    request.onUsage(usage(7,0.7));return 'earlier response';
  }),{...limits,sessionTokens:10,sessionUsd:1});
  try{
    const c=engine.conversation(),old=engine.enqueue(c.id,'prior root','budget-prior-001');
    await until(()=>store.get<Task>('tasks',old.id)?.state==='completed');
    const parent=engine.enqueue(c.id,'later parent','budget-parent-001');
    await until(()=>engine.tasks().some(t=>t.parentId===parent.id&&t.state==='cancelled'));
    assert.equal(engine.tasks().find(t=>t.parentId===parent.id)?.state,'cancelled');
    assert.equal(store.get<Task>('tasks',parent.id)?.state,'failed');
    const otherStore=new Store(':memory:');
    const other=new Engine(otherStore,fixture(async()=> 'done'),{...limits,sessionTokens:10});
    try{
      const rootConversation=other.conversation(),childConversation=other.conversation();
      const root=other.enqueue(rootConversation.id,'first','nested-budget-001');
      await until(()=>otherStore.get<Task>('tasks',root.id)?.state==='completed');
      const earlier={...root,usage:[usage(3,0.1)]};
      otherStore.save('tasks',earlier);
      const child:Task={...earlier,id:crypto.randomUUID(),requestId:'nested-child',conversationId:childConversation.id,
        parentId:root.id,usage:[usage(3,0.1)]};
      const join:Task={...earlier,id:crypto.randomUUID(),requestId:'nested-join',conversationId:childConversation.id,
        parentId:null,continuationOf:child.id,kind:'join',usage:[usage(5,0.1)]};
      otherStore.save('tasks',child);otherStore.save('tasks',join);
      assert.throws(()=>other.enqueue(rootConversation.id,'next','nested-budget-002'),/budget/);
    }finally{await other.stop();otherStore.close();}
  }finally{await engine.stop();store.close();}
});

test('retired child usage stays charged to its original session after synthesis and deletion',async()=>{
  const store=new Store(':memory:');
  const record=(input:number,costUsd:number)=>({input,output:0,cacheRead:0,cacheWrite:0,costUsd,costKind:'estimated' as const});
  const harness=fixture(async r=>{
    if(r.task.kind==='join'){r.onUsage(record(1,0.1));return 'combined';}
    if(r.task.prompt==='root'){r.onUsage(record(2,0.2));await delegate(r,'child work');return 'delegated';}
    r.onUsage(record(4,0.4));return 'child work done';
  });
  harness.deleteConversationSessions=async()=>{};
  const engine=new Engine(store,harness,{...limits,sessionUsd:0.73,reserveUsd:0.04});
  try {
    const c=engine.conversation(),parent=engine.enqueue(c.id,'root','retire-root-001');
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    const child=engine.tasks().find(t=>t.parentId===parent.id)!;
    assert.equal(child.state,'completed');
    assert.equal(store.retiredFamilyUsage(c.id).costUsd,0);
    await engine.stop();
    await engine.deleteConversation(child.conversationId);
    assert.equal(store.get<Task>('tasks',child.id),undefined);
    assert.equal(Math.round(store.retiredFamilyUsage(c.id).costUsd*100),40);
    assert.equal(Math.round(store.retiredFamilyUsage(c.id).tokens),4);
    assert.equal(Math.round(engine.usage().costUsd*100),70);
    assert.throws(()=>engine.enqueue(c.id,'new expensive turn','retire-root-002'),/Inference budget/);
    // The new ledger holds numeric amounts, not the child prompt or result.
    assert.doesNotMatch(JSON.stringify(store.retiredFamilyUsage(c.id)),/child work/);
  } finally {await engine.stop();store.close();}
});

test('reconciled child retry is independent after parent synthesis and retains least-privilege restrictions',async()=>{
  const store=new Store(':memory:');
  let childRuns=0;
  const atlas={list:async()=>[
    {name:'get_atlas_status',inputSchema:{type:'object'}},
    {name:'workspace_run_dev_task',inputSchema:{type:'object'}}
  ],call:async()=>({structuredContent:{result:{ok:true}}}),close:async()=>{}};
  const engine=new Engine(store,fixture(async request=>{
    if(request.task.prompt==='parent'){await delegate(request,'failing child',{tools:['atlas_get_atlas_status']});return 'parent delegated';}
    if(request.task.kind==='join')return 'parent synthesis (child failed)';
    if(request.task.prompt==='failing child'){
      childRuns++;
      assert.deepEqual(request.tools.map(t=>t.name),['atlas_get_atlas_status','relay_delegate']);
      if(childRuns===1)throw new Error('expected child failure');
      return 'standalone retry succeeded';
    }
    return 'unexpected';
  }),limits,atlas,{'configured':['verify']});
  try{
    const c=engine.conversation(),parent=engine.enqueue(c.id,'parent','retry-child-parent-001');
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    const original=engine.tasks().find(t=>t.parentId===parent.id)!;
    assert.equal(original.state,'failed');
    const originalResult=store.get<Task>('tasks',parent.id)!.result;
    const retry=engine.retry(original.id,true);
    assert.equal(retry.parentId,null);
    assert.equal(retry.retryDetachedFromParentId,parent.id);
    assert.equal(retry.attemptOf,original.id);
    assert.equal(engine.isInternalConversation(store.get('conversations',retry.conversationId)!),false);
    await until(()=>store.get<Task>('tasks',retry.id)?.state==='completed');
    assert.equal(store.get<Task>('tasks',retry.id)?.result,'standalone retry succeeded');
    assert.equal(store.get<Task>('tasks',parent.id)?.result,originalResult);
    assert.equal(engine.tasks().filter(t=>t.parentId===parent.id).length,1);
    assert.equal(engine.tasks().filter(t=>t.continuationOf===parent.id).length,1);
  }finally{await engine.stop();store.close();}
});

test('reconciled retry cannot change a queued synthesis child set',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixture(async()=> 'combined'),limits);
  try{
    const root=engine.conversation(),childSession=engine.conversation();
    const parent:Task={id:crypto.randomUUID(),conversationId:root.id,requestId:'queued-parent-001',
      prompt:'parent',state:'waiting_children',createdAt:new Date().toISOString(),parentId:null,
      dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
    const child:Task={...parent,id:crypto.randomUUID(),conversationId:childSession.id,
      requestId:'queued-child-001',parentId:parent.id,prompt:'child',state:'failed',error:'failed'};
    const join:Task={...parent,id:crypto.randomUUID(),requestId:'queued-join-001',
      parentId:null,continuationOf:parent.id,kind:'join',state:'queued',prompt:'synthesize'};
    parent.joinTaskId=join.id;
    store.save('tasks',parent);store.save('tasks',child);store.save('tasks',join);
    const retry=engine.retry(child.id,true);
    assert.equal(retry.parentId,null);
    assert.equal(engine.tasks().filter(t=>t.parentId===parent.id).length,1);
    assert.equal(store.get<Task>('tasks',parent.id)?.joinTaskId,join.id);
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    assert.equal(store.get<Task>('tasks',parent.id)?.result,'combined');
  }finally{await engine.stop();store.close();}
});

test('delegated Pi conversations do not appear in sidebar sessions, remain inspectable through task API',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixture(async r=>{
    if(r.task.prompt==='root'){await delegate(r,'internal child');return 'delegated';}
    return r.task.kind==='join'?'combined':'internal result';
  }),limits);
  const token='relay-orchestration-test-token-123';
  const server=createPlatform(engine,token,'.','cohere/north-mini-code:free');
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base='http://127.0.0.1:'+address.port+'/api';
  const api=(path:string,init:RequestInit={})=>fetch(base+path,{...init,
    headers:{Authorization:'Bearer '+token,...init.headers}});
  try{
    const c=engine.conversation(),parent=engine.enqueue(c.id,'root','hidden-agent-001');
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    const child=engine.tasks().find(t=>t.parentId===parent.id)!;
    const record=store.get<{internalParentConversationId?:string}>('conversations',child.conversationId)!;
    assert.equal(record.internalParentConversationId,c.id);
    const listed=await api('/sessions');
    assert.equal(listed.status,200);
    const sessions=(await listed.json() as {sessions:Array<{id:string}>}).sessions;
    assert.deepEqual(sessions.map(x=>x.id),[c.id]);
    assert.equal((await api('/sessions/'+child.conversationId)).status,200);
    const detail=await api('/task-console/tasks/'+child.id);
    assert.equal(detail.status,200);
    assert.equal((await detail.json() as {conversation:{internal:boolean}}).conversation.internal,true);
    assert.equal((await api('/sessions/'+child.conversationId+'/messages',{method:'POST',
      body:JSON.stringify({message:'inject',requestId:'injected-request-1'})})).status,409);
    // Legacy child records had no provenance; fallback inference also hides them.
    store.save('conversations',{...record,id:child.conversationId,internalParentConversationId:undefined} as
      {id:string;internalParentConversationId?:string});
    assert.deepEqual((await (await api('/sessions')).json() as {sessions:Array<{id:string}>}).sessions.map(x=>x.id),[c.id]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await engine.stop();store.close();}
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

test('HTTP deletion of a finished root removes nested hidden child sessions and preserves global usage',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-tree-delete-'));
  const store=new Store(join(directory,'state.sqlite'));
  const pi=new PiHarness(directory,'cohere/north-mini-code:free');
  const count=(costUsd:number)=>({input:1,output:0,cacheRead:0,cacheWrite:0,costUsd,costKind:'estimated' as const});
  const harness=fixture(async request=>{
    request.onUsage(count(.1));
    if(request.task.prompt==='root private'){
      await delegate(request,'child private');
      return 'root result';
    }
    if(request.task.prompt==='child private'){
      await delegate(request,'grandchild private');
      return 'child result';
    }
    return 'result '+request.task.prompt;
  });
  harness.deleteConversationSessions=id=>pi.deleteConversationSessions(id);
  const engine=new Engine(store,harness,limits);
  const token='relay-nested-tree-delete-token-123';
  const server=createPlatform(engine,token,'.','cohere/north-mini-code:free');
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base='http://127.0.0.1:'+address.port;
  const api=(path:string,method='GET')=>fetch(base+'/api'+path,{method,
    headers:{Authorization:'Bearer '+token}});
  try {
    const root=engine.conversation(),parent=engine.enqueue(root.id,'root private','tree-root-001');
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    await engine.stop();
    const conversations=store.all<Conversation>('conversations');
    assert.equal(conversations.length,3);
    const children=conversations.filter(c=>c.id!==root.id);
    assert.ok(children.every(c=>!!c.internalParentConversationId));
    for(const id of conversations.map(c=>c.id)){
      const dir=join(directory,'sessions',id);
      await mkdir(dir,{recursive:true});
      await writeFile(join(dir,'private.jsonl'),'private historical transcript');
    }
    const usageBefore=engine.usage();
    assert.equal(Math.round(usageBefore.costUsd*100),50);
    const visible=await api('/sessions');
    assert.deepEqual((await visible.json() as {sessions:Array<{id:string}>}).sessions.map(x=>x.id),[root.id]);
    const result=await api('/sessions/'+root.id,'DELETE');
    assert.equal(result.status,204);
    assert.equal(store.all<Conversation>('conversations').length,0);
    assert.equal(engine.tasks().length,0);
    assert.deepEqual(store.pendingSessionDeletions(),[]);
    assert.deepEqual(engine.usage(),usageBefore);
    assert.equal(store.retiredUsage().count,5);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM retired_family_usage').get()?.n,0);
    for(const id of conversations.map(c=>c.id))await assert.rejects(access(join(directory,'sessions',id)),/ENOENT/);
    assert.equal((await api('/sessions/'+root.id)).status,404);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('root deletion refuses unresolved descendant and leaves the entire tree untouched',async()=>{
  const store=new Store(':memory:');
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const harness=fixture(async r=>{
    if(r.task.prompt==='root'){await delegate(r,'slow child');return 'delegated';}
    if(r.task.prompt==='slow child'){await gate;return 'complete';}
    return 'join';
  });
  harness.deleteConversationSessions=async()=>{};
  const engine=new Engine(store,harness,limits);
  try {
    const c=engine.conversation(),parent=engine.enqueue(c.id,'root','active-tree-001');
    await until(()=>engine.tasks().some(t=>t.parentId===parent.id&&t.state==='running'));
    await assert.rejects(engine.deleteConversation(c.id),/active or uncertain/);
    assert.equal(store.all<Conversation>('conversations').length,2);
    assert.equal(store.pendingSessionDeletions().length,0);
    release();await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    await engine.stop();await engine.deleteConversation(c.id);
    assert.equal(store.all<Conversation>('conversations').length,0);
  }finally{release();await engine.stop();store.close();}
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

test('nested delegated token ceiling includes both sibling children and blocks synthesis after overspend',async()=>{
  const store=new Store(':memory:');
  const spent=(tokens:number)=>({input:tokens,output:0,cacheRead:0,cacheWrite:0,
    costUsd:0.01,costKind:'estimated' as const});
  const executed:string[]=[];
  const engine=new Engine(store,fixture(async request=>{
    const task=request.task;
    executed.push(task.kind==='join'?'join:'+task.continuationOf:task.prompt);
    if(task.prompt==='root'){
      await delegate(request,'coordinator',{maxTokens:12,profile:'researcher'});
      return 'Delegated coordinator';
    }
    if(task.prompt.startsWith('coordinator')){
      await delegate(request,'worker A',{maxTokens:12});
      await delegate(request,'worker B',{maxTokens:12});
      return 'Delegated both workers';
    }
    if(task.prompt.startsWith('worker')){
      request.onUsage(spent(8));
      request.signal.throwIfAborted();
      return 'worker result';
    }
    return 'Root reported aggregate failure';
  }),{...limits,concurrency:1});
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root','subtree-budget-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const coordinator=engine.tasks().find(t=>t.prompt==='coordinator')!;
    const children=engine.tasks().filter(t=>t.parentId===coordinator.id);
    assert.equal(children.length,2);
    assert.deepEqual(children.map(t=>t.state),['completed','cancelled'],
      'the second worker must be stopped by aggregate usage, even though its own cap is not reached');
    assert.equal(coordinator.state,'failed','nested synthesis must not spend past its parent ceiling');
    assert.ok(!engine.tasks().some(t=>t.continuationOf===coordinator.id),
      'a nested continuation cannot bypass the exhausted subtree cap');
    assert.equal(store.get<Task>('tasks',root.id)?.state,'completed',
      'unbudgeted ancestor still synthesises the failed branch');
    assert.ok(engine.tasks().some(t=>t.continuationOf===root.id&&t.state==='completed'));
    assert.equal(executed.filter(x=>x.startsWith('worker')).length,2);
  }finally{await engine.stop();store.close();}
});

test('delegated cost ceiling aggregates sibling spending while preserving run reservations',async()=>{
  const store=new Store(':memory:');
  const run=(usd:number)=>({input:1,output:0,cacheRead:0,cacheWrite:0,
    costUsd:usd,costKind:'estimated' as const});
  const executed:string[]=[];
  const engine=new Engine(store,fixture(async request=>{
    executed.push(request.task.prompt);
    if(request.task.prompt==='root'){
      await delegate(request,'cost coordinator',{maxCostUsd:0.4});
      return 'Root handed off';
    }
    if(request.task.prompt==='cost coordinator'){
      await delegate(request,'paid A',{maxCostUsd:0.4});
      await delegate(request,'paid B',{maxCostUsd:0.4});
      return 'Coordinator handed off';
    }
    if(request.task.prompt==='paid A'){
      request.onUsage(run(0.27));
      return 'Paid A';
    }
    if(request.task.prompt==='paid B'){request.onUsage(run(0.16));request.signal.throwIfAborted();return 'unexpected';}
    return request.task.kind==='join'?'A partial result was returned':'unexpected';
  }),{...limits,concurrency:1,reserveUsd:0.05});
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root','cost-tree-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const a=engine.tasks().find(t=>t.prompt==='paid A')!;
    const b=engine.tasks().find(t=>t.prompt==='paid B')!;
    assert.equal(a.state,'completed');
    assert.equal(b.state,'cancelled','0.27 + 0.16 sibling spend exceeds the shared 0.4 cap');
    assert.ok(executed.includes('paid B'));
    assert.ok(!engine.tasks().some(t=>t.continuationOf===b.parentId),
      'a parent continuation must not spend after the family ceiling is exhausted');
  }finally{await engine.stop();store.close();}
});
