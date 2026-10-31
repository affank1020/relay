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
