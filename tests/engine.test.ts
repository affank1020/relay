import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, type Limits } from '../src/engine.js';
import { Store, type Task } from '../src/store.js';
import type { Harness, HarnessRequest } from '../src/harness.js';
import { PiHarness, ProviderRateLimitError, isPiRateLimited } from '../src/harness.js';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export const limits:Limits={concurrency:2,queue:64,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000};
export function fixtureHarness(run:(r:HarnessRequest)=>Promise<string>):Harness { return {version:1,capabilities:{persistence:true,cancellation:true,tools:true},run}; }
export async function until(predicate:()=>boolean) { const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Condition did not become true');await delay(5);} }

test('persisted tasks, events and idempotency survive reopening; running tasks become interrupted',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-store-'));
  const file=join(root,'state.sqlite');let store=new Store(file);
  try {
    const engine=new Engine(store,fixtureHarness(async()=> 'answer'),limits);
    const c=engine.conversation();const task=engine.enqueue(c.id,'hello','request-001');
    assert.equal(engine.enqueue(c.id,'hello','request-001').id,task.id);
    assert.throws(()=>engine.enqueue(c.id,'different','request-001'),/identity conflict/);
    await until(()=>engine.tasks()[0].state==='completed');await engine.stop();
    const queued:Task={...task,id:crypto.randomUUID(),requestId:'request-002',state:'running'};
    store.save('tasks',queued);const events=store.events(c.id);assert.ok(events.every((e,i)=>!i||e.sequence>events[i-1].sequence));
    store.close();store=new Store(file);
    const restored=new Engine(store,fixtureHarness(async()=>{throw new Error('Must not replay');}),limits);
    assert.equal(restored.tasks().find(t=>t.id===task.id)?.result,'answer');
    assert.equal(restored.tasks().find(t=>t.id===queued.id)?.state,'interrupted');
    assert.deepEqual(store.events(c.id,events.at(-1)!.sequence).map(e=>e.state),['interrupted']);
    assert.throws(()=>restored.retry(queued.id,false),/reconciliation/);
    await restored.stop();
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('scheduler bounds concurrency, serializes conversations and supplies dependency results',async()=>{
  const store=new Store(':memory:');let running=0,maximum=0;const order:string[]=[];
  const engine=new Engine(store,fixtureHarness(async r=>{running++;maximum=Math.max(maximum,running);order.push(r.task.prompt);await delay(15);running--;return 'result '+r.task.prompt;}),limits);
  try {
    const c=engine.conversation(),other=engine.conversation();
    const a=engine.enqueue(c.id,'first','request-001');engine.enqueue(c.id,'second','request-002');
    engine.enqueue(other.id,'dependent','request-003',[a.id]);
    await until(()=>engine.tasks().every(t=>t.state==='completed'));
    assert.ok(maximum<=2);assert.equal(order[0],'first');assert.match(order.at(-1)!,/result first/);
  }finally{await engine.stop();store.close();}
});

test('cancellation, dependency failure, queue bounds and inference budgets fail closed',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixtureHarness(async r=>{await delay(5000,undefined,{signal:r.signal});return ''; }),{...limits,queue:2});
  try{
    const c=engine.conversation(),d=engine.conversation();const a=engine.enqueue(c.id,'wait','request-001');
    engine.enqueue(d.id,'child','request-002',[a.id]);assert.throws(()=>engine.enqueue(c.id,'full','request-003'),/queue is full/);
    await until(()=>engine.tasks()[0].state==='running');await engine.cancel(a.id);
    await until(()=>engine.tasks().every(t=>['cancelled','failed'].includes(t.state)));
  }finally{await engine.stop();store.close();}
  const budgetStore=new Store(':memory:');
  const budget=new Engine(budgetStore,fixtureHarness(async r=>{r.onUsage({input:10,output:5,cacheRead:0,cacheWrite:0,costUsd:0,costKind:'estimated'});return 'done';}),{...limits,sessionTokens:15});
  try{const c=budget.conversation();budget.enqueue(c.id,'hello','request-001');await until(()=>budget.tasks()[0].state==='cancelled');assert.throws(()=>budget.enqueue(c.id,'again','request-002'),/budget/);}
  finally{await budget.stop();budgetStore.close();}
});

test('delegation has bounded children and returns persistent independent tasks',async()=>{
  const store=new Store(':memory:');let delegated=false;
  const engine=new Engine(store,fixtureHarness(async r=>{
    if(!delegated){delegated=true;const tool=r.tools.find(t=>t.name==='relay_delegate')!;await tool.execute('child',{prompt:'independent child'},r.signal,undefined,{} as never);}
    return 'done';
  }),limits);
  try{const c=engine.conversation();const parent=engine.enqueue(c.id,'delegate','request-001');await until(()=>engine.tasks().length===2&&engine.tasks().every(t=>t.state==='completed'));assert.equal(engine.tasks()[1].parentId,parent.id);}
  finally{await engine.stop();store.close();}
});

test('real Pi SDK initializes restricted persistent session before cancellation without inference', {timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-adapter-'));const store=new Store(':memory:');
  const engine=new Engine(store,fixtureHarness(async()=>''),limits);const c=engine.conversation();
  const task:Task={id:crypto.randomUUID(),conversationId:c.id,requestId:'pi-startup',prompt:'must not infer',state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  const controller=new AbortController();controller.abort(new Error('cancel-before-prompt'));
  try{await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free').run({version:1,task,signal:controller.signal,tools:[],onText:()=>assert.fail(),onUsage:()=>assert.fail()}),/cancel-before-prompt/);}
  finally{await engine.stop();store.close();await rm(root,{recursive:true,force:true});}
});


test('failed task identifies the safe execution stage without disclosing exception contents',async()=>{
  const store=new Store(':memory:');
  const atlas={list:async()=>{throw new Error('secret-atlas-response');},call:async()=>{throw new Error('unreachable');},close:async()=>{}};
  const engine=new Engine(store,fixtureHarness(async()=>assert.fail('harness must not run')),limits,atlas);
  try {
    const c=engine.conversation();engine.enqueue(c.id,'status','request-stage-001');
    await until(()=>engine.tasks()[0]?.state==='failed');
    assert.match(engine.tasks()[0].error||'',/atlas_tool_discovery/);
    assert.doesNotMatch(engine.tasks()[0].error||'',/secret-atlas-response/);
  } finally {await engine.stop();store.close();}

  const secondStore=new Store(':memory:');
  const second=new Engine(secondStore,fixtureHarness(async r=>{
    r.onPhase?.('creating_session');
    throw new TypeError('private provider credential');
  }),limits);
  try {
    const c=second.conversation();second.enqueue(c.id,'status','request-stage-002');
    await until(()=>second.tasks()[0]?.state==='failed');
    assert.match(second.tasks()[0].error||'',/creating_session \(TypeError\)/);
    assert.doesNotMatch(second.tasks()[0].error||'',/private provider credential/);
  } finally {await second.stop();secondStore.close();}
});

test('real Pi session accepts all 23 Atlas tools and relay_delegate before cancellation', {timeout:65000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-tool-startup-'));
  const controller=new AbortController();controller.abort(new Error('cancel-before-prompt'));
  const tools:ToolDefinition[]=Array.from({length:23},(_,i)=>({
    name:'atlas_diagnostic_'+i,label:'Atlas diagnostic '+i,description:'Read-only fixture',
    parameters:Type.Unsafe<Record<string,unknown>>({type:'object',properties:{id:{type:'string'}},additionalProperties:false}),
    execute:async()=>({content:[{type:'text' as const,text:'never executed'}],details:{}}),
  }));
  tools.push({
    name:'relay_delegate',label:'Delegate task',description:'Diagnostic delegation fixture',
    parameters:Type.Object({prompt:Type.String({minLength:1,maxLength:6000}),dependencies:Type.Optional(Type.Array(Type.String(),{maxItems:8}))}),
    execute:async()=>({content:[{type:'text' as const,text:'never executed'}],details:{}}),
  });
  const task:Task={id:crypto.randomUUID(),conversationId:crypto.randomUUID(),requestId:'tool-startup',prompt:'must not infer',state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  try {
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free').run({version:1,task,signal:controller.signal,tools,onText:()=>assert.fail('text not expected'),onUsage:()=>assert.fail('usage not expected')}),/cancel-before-prompt/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Pi rate-limit classifier detects provider rate limit messages',()=>{
  assert.equal(isPiRateLimited('HTTP 429 Too Many Requests'),true);
  assert.equal(isPiRateLimited('OpenRouter rate limit exceeded'),true);
  assert.equal(isPiRateLimited('Model not found'),false);
  assert.equal(isPiRateLimited(undefined),false);
});

test('provider rate limit shows actionable safe error without retrying',async()=>{
  const store=new Store(':memory:');let runs=0;
  const engine=new Engine(store,fixtureHarness(async request=>{
    runs++;
    request.onPhase?.('finalizing_response');
    throw new ProviderRateLimitError();
  }),limits);
  try {
    const conversation=engine.conversation();
    engine.enqueue(conversation.id,'list Atlas projects','request-rate-001');
    await until(()=>engine.tasks()[0]?.state==='failed');
    const task=engine.tasks()[0];
    assert.equal(runs,1);
    assert.match(task.error||'',/OpenRouter rate limit reached \(HTTP 429\)/);
    assert.match(task.error||'',/reconcile any dispatched Atlas operation/i);
    assert.doesNotMatch(task.error||'',/credentials|secret|Bearer /i);
  } finally {await engine.stop();store.close();}
});
