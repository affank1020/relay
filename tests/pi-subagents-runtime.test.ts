import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PiSubagentsRpc, type SubagentsBus } from '../src/pi-subagents-rpc.js';
import { piSubagentEnabled, piSubagentRuntime } from '../src/pi-subagents-runtime.js';
import { Store, type Task } from '../src/store.js';
import { Engine, type Limits } from '../src/engine.js';
import type { Harness } from '../src/harness.js';
import { setTimeout as delay } from 'node:timers/promises';

const limits:Limits={concurrency:1,queue:8,sessionUsd:0,globalUsd:0,sessionTokens:0,
  reserveUsd:0,maxRunMs:5000};

test('Pi subagent mode only permits root non-delegated tasks',()=>{
  const old=process.env.RELAY_PI_SUBAGENTS;
  try{
    process.env.RELAY_PI_SUBAGENTS='1';
    assert.equal(piSubagentEnabled({parentId:null}),true);
    assert.equal(piSubagentEnabled({parentId:'parent'}),false);
    assert.equal(piSubagentEnabled({parentId:null,delegation:{toolNames:[]}}),false);
    process.env.RELAY_PI_SUBAGENTS='0';
    assert.equal(piSubagentEnabled({parentId:null}),false);
  }finally{
    if(old===undefined)delete process.env.RELAY_PI_SUBAGENTS;
    else process.env.RELAY_PI_SUBAGENTS=old;
  }
});

test('native subagent mode never advertises old Relay delegation scheduler',async()=>{
  const old=process.env.RELAY_PI_SUBAGENTS;
  process.env.RELAY_PI_SUBAGENTS='1';
  const store=new Store(':memory:');
  let invoked=0;
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      assert.equal(request.tools.some(t=>t.name==='relay_delegate'),false);
      invoked++;
      return 'Parent finished without old scheduler.';
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const c=engine.conversation(),task=engine.enqueue(c.id,'evaluate a supplied summary',randomUUID());
    for(let i=0;i<200&&store.get<Task>('tasks',task.id)?.state!=='completed';i++)await delay(10);
    assert.equal(store.get<Task>('tasks',task.id)?.state,'completed');
    assert.equal(invoked,1);
  }finally{
    await engine.stop();store.close();
    if(old===undefined)delete process.env.RELAY_PI_SUBAGENTS;
    else process.env.RELAY_PI_SUBAGENTS=old;
  }
});

test('restricted Pi agent definition denies all built-in execution and external extensions',async()=>{
  const file=await readFile('.pi/agents/relay-isolated.md','utf8');
  const policy=JSON.parse(await readFile('.pi/subagents.json','utf8')) as Record<string,unknown>;
  assert.match(file,/name: relay-isolated/);
  assert.match(file,/tools: read/);
  assert.match(file,/disallowed_tools: read, bash, powershell, write, edit, grep, find, ls/);
  assert.match(file,/extensions: false/);
  assert.match(file,/skills: false/);
  assert.match(file,/isolated: true/);
  assert.equal(policy.disableDefaultAgents,true);
  assert.equal(policy.schedulingEnabled,false);
});

test('model-facing pi delegation bridges to extension RPC with fixed safe profile',async()=>{
  const signal=new AbortController().signal;
  const handlers=new Map<string,Set<(data:unknown)=>void>>();
  const bus:SubagentsBus={
    on(name,fn){
      const list=handlers.get(name)??new Set<(data:unknown)=>void>();
      list.add(fn);handlers.set(name,list);
      return ()=>{list.delete(fn);if(!list.size)handlers.delete(name);};
    },
    emit(name,data){
      const args=data as {requestId:string;type?:string;options?:Record<string,unknown>};
      if(name==='subagents:rpc:ping')
        bus.emit(name+':reply:'+args.requestId,{success:true,data:{version:2}});
      if(name==='subagents:rpc:spawn'){
        assert.equal(args.type,'relay-isolated');
        assert.equal(args.options?.isolated,true);
        assert.equal(args.options?.inheritContext,false);
        bus.emit(name+':reply:'+args.requestId,{success:true,data:{id:'native-child'}});
        queueMicrotask(()=>bus.emit('subagents:completed',{id:'native-child',result:'Analysis completed'}));
      }
      for(const fn of handlers.get(name)??[])fn(data);
    }
  };
  const transitions:string[]=[];
  const runtime=piSubagentRuntime(signal,event=>transitions.push(event.status));
  runtime.extensionFactory({events:bus});
  const response=await runtime.tool.execute('tool-call-1',{prompt:'Analyse supplied data'},
    signal,undefined,{} as never);
  assert.match(JSON.stringify(response),/Analysis completed/);
  assert.match(JSON.stringify(response),/verifiedExternalSources/);
  assert.deepEqual(transitions,['completed']);
  assert.equal(handlers.size,0);
});
