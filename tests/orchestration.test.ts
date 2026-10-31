import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, type Limits } from '../src/engine.js';
import { Store, type Task } from '../src/store.js';
import type { Harness, HarnessRequest } from '../src/harness.js';

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
