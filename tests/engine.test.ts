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
    engine.enqueue(c.id,'dependent','request-003',[a.id]);
    await until(()=>engine.tasks().every(t=>t.state==='completed'));
    assert.ok(maximum<=2);assert.equal(order[0],'first');assert.match(order.at(-1)!,/result first/);
  }finally{await engine.stop();store.close();}
});

test('cancellation, dependency failure, queue bounds and inference budgets fail closed',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,fixtureHarness(async r=>{await delay(5000,undefined,{signal:r.signal});return ''; }),{...limits,queue:2});
  try{
    const c=engine.conversation(),d=engine.conversation();const a=engine.enqueue(c.id,'wait','request-001');
    engine.enqueue(c.id,'child','request-002',[a.id]);assert.throws(()=>engine.enqueue(c.id,'full','request-003'),/queue is full/);
    await until(()=>engine.tasks()[0].state==='running');await engine.cancel(a.id);
    await until(()=>engine.tasks().every(t=>['cancelled','failed'].includes(t.state)));
  }finally{await engine.stop();store.close();}
  const budgetStore=new Store(':memory:');
  const budget=new Engine(budgetStore,fixtureHarness(async r=>{r.onUsage({input:10,output:5,cacheRead:0,cacheWrite:0,costUsd:0,costKind:'estimated'});return 'done';}),{...limits,sessionTokens:15});
  try{const c=budget.conversation();budget.enqueue(c.id,'hello','request-001');await until(()=>budget.tasks()[0].state==='cancelled');assert.throws(()=>budget.enqueue(c.id,'again','request-002'),/budget/);}
  finally{await budget.stop();budgetStore.close();}
});

test('real Pi SDK initializes restricted persistent session before cancellation without inference', {timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-adapter-'));const store=new Store(':memory:');
  const engine=new Engine(store,fixtureHarness(async()=>''),limits);const c=engine.conversation();
  const task:Task={id:crypto.randomUUID(),conversationId:c.id,requestId:'pi-startup',prompt:'must not infer',state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  const controller=new AbortController();controller.abort(new Error('cancel-before-prompt'));
  try{await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free').run({version:1,task,signal:controller.signal,tools:[],onText:()=>assert.fail(),onUsage:()=>assert.fail()}),/cancel-before-prompt/);}
  finally{await engine.stop();store.close();await rm(root,{recursive:true,force:true});}
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

test('local model choice persists through execution and explicit reconciliation retry',async()=>{
  const store=new Store(':memory:');
  const registry={defaultKey:'openrouter/cohere/north-mini-code:free',models:[{key:'openrouter/cohere/north-mini-code:free',provider:'openrouter' as const,id:'cohere/north-mini-code:free',label:'Cloud'},{key:'ollama/qwen3:4b',provider:'ollama' as const,id:'qwen3:4b',label:'MacBook'}],ollama:{baseUrl:'http://127.0.0.1:11434/v1',modelIds:['qwen3:4b']}};
  const chosen:string[]=[];
  const engine=new Engine(store,fixtureHarness(async request=>{chosen.push(request.modelKey||'missing');throw new Error('fixture failure');}),limits,undefined,{},registry);
  try{
    assert.throws(()=>engine.conversation('ollama/missing'),/Invalid model selection/);
    const conversation=engine.conversation('ollama/qwen3:4b');
    assert.equal(store.get<{modelKey?:string}>('conversations',conversation.id)?.modelKey,'ollama/qwen3:4b');
    const original=engine.enqueue(conversation.id,'local test','local-choice-001');
    await until(()=>engine.tasks().find(t=>t.id===original.id)?.state==='failed');
    assert.deepEqual(chosen,['ollama/qwen3:4b']);
    const retry=engine.retry(original.id,true);
    await until(()=>engine.tasks().find(t=>t.id===retry.id)?.state==='failed');
    assert.deepEqual(chosen,['ollama/qwen3:4b','ollama/qwen3:4b']);
    assert.equal(store.get<{modelKey?:string}>('conversations',retry.conversationId)?.modelKey,'ollama/qwen3:4b');
  }finally{await engine.stop();store.close();}
});

test('already cancelled local Pi run does not probe or start inference', {timeout:65000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-ollama-startup-'));
  const registry={defaultKey:'openrouter/cohere/north-mini-code:free',models:[{key:'openrouter/cohere/north-mini-code:free',provider:'openrouter' as const,id:'cohere/north-mini-code:free',label:'OpenRouter'},{key:'ollama/qwen3:4b',provider:'ollama' as const,id:'qwen3:4b',label:'MacBook'}],ollama:{baseUrl:'http://127.0.0.1:11434/v1',modelIds:['qwen3:4b']}};
  const controller=new AbortController();controller.abort(new Error('cancel-before-inference'));
  const task:Task={id:crypto.randomUUID(),conversationId:crypto.randomUUID(),requestId:'ollama-startup',prompt:'never infer',state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  const phases:string[]=[];
  try {
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free',registry).run({version:1,task,modelKey:'ollama/qwen3:4b',signal:controller.signal,tools:[],onText:()=>assert.fail(),onUsage:()=>assert.fail(),onPhase:p=>phases.push(p)}),/cancel-before-inference/);
    assert.ok(phases.includes('loading_model'));
    assert.ok(!phases.includes('checking_local_provider'),'cancelled requests must not probe Ollama');
  }finally{await rm(root,{recursive:true,force:true});}
});
