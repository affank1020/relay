import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, type Task, type Conversation } from '../src/store.js';
import { PiSubagentLedger } from '../src/pi-subagent-ledger.js';
import { Engine, type Limits } from '../src/engine.js';
import type { Harness } from '../src/harness.js';

const limits:Limits={concurrency:2,queue:64,sessionUsd:0,globalUsd:0,
  sessionTokens:0,reserveUsd:0,maxRunMs:5000};
const fixture=()=>{
  const store=new Store(':memory:');
  const conversationId=randomUUID();
  const conversation:Conversation={id:conversationId,title:'Main chat',createdAt:new Date().toISOString()};
  store.save('conversations',conversation);
  const parent:Task={id:randomUUID(),conversationId,requestId:randomUUID(),prompt:'Delegate analysis',
    state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],
    attemptOf:null,result:'',error:null,usage:[],agentId:randomUUID(),agentRunId:randomUUID()};
  store.save('tasks',parent);
  return {store,parent};
};

test('Pi agent lifecycle is a durable child task projection, never a second job',()=>{
  const {store,parent}=fixture();
  try{
    const ledger=new PiSubagentLedger(store,parent);
    const first=ledger.record({agentId:'pi-agent-01',status:'started'});
    assert.ok(first);
    assert.equal(first.kind,'pi_subagent');
    assert.equal(first.parentId,parent.id);
    assert.equal(first.state,'running');
    assert.ok(first.conversationId!==parent.conversationId);
    assert.equal(store.get<Conversation>('conversations',first.conversationId)?.internalParentConversationId,
      parent.conversationId);
    assert.equal(store.isInternalConversationId(first.conversationId),true);
    const done=ledger.record({agentId:'pi-agent-01',status:'completed',result:'Evidence from prompt only'});
    assert.equal(done?.id,first.id);
    assert.equal(done?.state,'completed');
    assert.equal(done?.result,'Evidence from prompt only');
    assert.equal(ledger.record({agentId:'pi-agent-01',status:'completed',result:'duplicate'})?.result,
      'Evidence from prompt only');
    assert.equal(store.all<Task>('tasks').length,2);
    assert.ok(store.events(parent.conversationId).some(e=>e.childTaskId===first.id&&e.state==='completed'));
  }finally{store.close();}
});

test('Pi completion after parent interruption never resurrects stale agent run',()=>{
  const {store,parent}=fixture();
  try{
    const ledger=new PiSubagentLedger(store,parent);
    ledger.record({agentId:'pi-agent-2',status:'started'});
    store.save('tasks',{...parent,state:'interrupted'});
    assert.equal(ledger.record({agentId:'pi-agent-2',status:'completed',result:'too late'}),undefined);
    assert.equal(store.all<Task>('tasks').find(t=>t.kind==='pi_subagent')?.state,'running');
    assert.equal(ledger.record({agentId:'bad/id',status:'started'}),undefined);
    assert.equal(store.all<Task>('tasks').length,2);
  }finally{store.close();}
});

test('Pi child failure is tracked without claiming successful research',()=>{
  const {store,parent}=fixture();
  try{
    const ledger=new PiSubagentLedger(store,parent);
    const failed=ledger.record({agentId:'pi-agent-3',status:'failed',error:'Provider failed'});
    assert.equal(failed?.state,'failed');
    assert.equal(failed?.result,'');
    assert.equal(failed?.error,'Provider failed');
  }finally{store.close();}
});

test('Engine uses one Pi executor and does not schedule a duplicate join for its projections',async()=>{
  const old=process.env.RELAY_PI_SUBAGENTS;
  process.env.RELAY_PI_SUBAGENTS='1';
  const store=new Store(':memory:');
  let runs=0;
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      runs++;
      request.onSubagent?.({agentId:'child-live',status:'started'});
      request.onSubagent?.({agentId:'child-live',status:'completed',result:'Child analysis'});
      return 'Parent synthesized the child result';
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const chat=engine.conversation();
    const root=engine.enqueue(chat.id,'Summarize input',randomUUID());
    for(let i=0;i<300&&store.get<Task>('tasks',root.id)?.state!=='completed';i++)await delay(5);
    assert.equal(store.get<Task>('tasks',root.id)?.state,'completed');
    assert.equal(runs,1);
    assert.equal(engine.tasks().filter(t=>t.kind==='join').length,0);
    const child=engine.tasks().find(t=>t.parentId===root.id&&t.kind==='pi_subagent');
    assert.equal(child?.state,'completed');
    assert.equal(child?.result,'Child analysis');
    assert.ok(child?.conversationId!==chat.id);
  }finally{
    await engine.stop();store.close();
    if(old===undefined)delete process.env.RELAY_PI_SUBAGENTS;
    else process.env.RELAY_PI_SUBAGENTS=old;
  }
});

test('recovery interrupts a Pi subagent projection rather than rescheduling it',async()=>{
  const {store,parent}=fixture();
  const ledger=new PiSubagentLedger(store,parent);
  const child=ledger.record({agentId:'pi-agent-restart',status:'started'});
  assert.equal(child?.state,'running');
  let calls=0;
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async()=>{calls++;return 'Unexpected resumed run';}};
  const recovering=new Engine(store,harness,limits);
  try{
    assert.equal(store.get<Task>('tasks',parent.id)?.state,'interrupted');
    assert.equal(store.get<Task>('tasks',child!.id)?.state,'interrupted');
    assert.equal(ledger.record({agentId:'pi-agent-restart',status:'completed',result:'late'}),undefined);
    assert.equal(calls,0);
  }finally{await recovering.stop();store.close();}
});

test('a Pi completion event without result is a failed child, not verified completion',()=>{
  const {store,parent}=fixture();
  try {
    const ledger=new PiSubagentLedger(store,parent);
    const child=ledger.record({agentId:'missing-result',status:'completed'});
    assert.equal(child?.state,'failed');
    assert.equal(child?.result,'');
    assert.match(child?.error??'',/did not provide a completed result/);
  }finally{store.close();}
});

test('Pi child usage and nested MCP receipts are charged to real child identity',()=>{
  const {store,parent}=fixture();
  try{
    const ledger=new PiSubagentLedger(store,parent);
    const child=ledger.record({agentId:'pi-budget-child',status:'started'});
    assert.ok(child);
    const usage={input:150,output:20,cacheRead:5,cacheWrite:0,
      costUsd:0.004,costKind:'estimated' as const};
    const updated=ledger.recordUsage('pi-budget-child',usage);
    assert.deepEqual(updated?.usage,[usage]);
    ledger.recordRead('pi-budget-child','mcp__github__issue_read',true);
    ledger.recordRead('pi-budget-child','mcp__github__create_issue',false);
    const receipts=store.invocationRecords(child.id);
    assert.equal(receipts.length,2);
    assert.deepEqual(receipts.map(v=>v.state).sort(),['completed','failed_read']);
    assert.ok(store.events(child.conversationId).some(e=>
      e.type==='tool'&&e.tool==='mcp__github__issue_read'&&e.state==='completed'));
    assert.ok(store.events(parent.conversationId).some(e=>
      e.type==='delegated_tool'&&e.childTaskId===child.id));
    assert.equal(JSON.stringify(receipts).includes('issue_number'),false);
    ledger.record({agentId:'pi-budget-child',status:'completed',result:'done'});
    assert.equal(ledger.recordUsage('pi-budget-child',usage),undefined);
    assert.equal(store.invocationRecords(child.id).length,2);
  }finally{store.close();}
});

test('Pi child accounting is revoked after parent cancellation and ignores unbound ids',()=>{
  const {store,parent}=fixture();
  try{
    const ledger=new PiSubagentLedger(store,parent);
    ledger.record({agentId:'child-valid',status:'started'});
    const usage={input:5,output:3,cacheRead:0,cacheWrite:0,costUsd:0,costKind:'estimated' as const};
    assert.equal(ledger.recordUsage('other-agent',usage),undefined);
    store.save('tasks',{...parent,state:'cancelled'});
    assert.equal(ledger.recordUsage('child-valid',usage),undefined);
    ledger.recordRead('child-valid','mcp__github__issue_read',true);
    const child=store.all<Task>('tasks').find(t=>t.parentId===parent.id)!;
    assert.equal(child.usage.length,0);
    assert.equal(store.invocationRecords(child.id).length,0);
  }finally{store.close();}
});
