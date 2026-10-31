import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { Store, type Task } from '../src/store.js';
import { Engine, type Limits } from '../src/engine.js';
import { createPlatform } from '../src/platform.js';

const limits:Limits={concurrency:2,queue:24,sessionUsd:0,globalUsd:0,sessionTokens:0,
  reserveUsd:0,maxRunMs:5000};
test('authenticated chat snapshot reconstructs child agents without exposing hidden conversation or raw tool payloads',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async()=> 'not called'},limits);
  const rootConversation=engine.conversation();
  const hiddenConversation=engine.conversation();
  store.save('conversations',{...hiddenConversation,internalParentConversationId:rootConversation.id});
  const root:Task={id:crypto.randomUUID(),conversationId:rootConversation.id,requestId:'root',
    prompt:'Summarise research',createdAt:'2026-10-31T12:00:00Z',state:'completed',
    parentId:null,dependencies:[],attemptOf:null,result:'Parent delegated; awaiting child',error:null,usage:[]};
  root.state='waiting_children';
  const child:Task={...root,id:crypto.randomUUID(),conversationId:hiddenConversation.id,
    requestId:'child',parentId:root.id,prompt:'Find documented issues',
    state:'running',result:'PRIVATE_INTERNAL_CHILD_TRANSCRIPT',agentRunId:crypto.randomUUID(),
    delegation:{schemaVersion:1,profile:'researcher',toolNames:[],modelKey:null,
      context:'PRIVATE_DELEGATED_CONTEXT',maxTokens:null,maxCostUsd:null}};
  store.save('tasks',root);store.save('tasks',child);
  store.event(hiddenConversation.id,{taskId:child.id,agentRunId:child.agentRunId,
    type:'tool',state:'completed',tool:'mcp_github_issue_read',invocationId:'read-test'});
  const token='relay-agent-ui-test-auth-token-001';
  const server=createPlatform(engine,token,'.','cohere/north-mini-code:free');
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const address=server.address();
    assert.ok(address&&typeof address==='object');
    const base='http://127.0.0.1:'+address.port;
    const url=base+'/api/sessions/'+rootConversation.id;
    const denied=await fetch(url);
    assert.equal(denied.status,401);
    const headers={Authorization:'Bearer '+token};
    const snapshot=await (await fetch(url,{headers})).json() as {
      tasks:Task[];turns:{text:string}[];
      agents:Record<string,Array<{id:string;state:string;agentRunId:string;lastTool:{name:string;state:string}}>>;
    };
    assert.deepEqual(snapshot.tasks.map(t=>t.id),[root.id]);
    assert.equal(snapshot.agents[root.id]?.length,1);
    assert.equal(snapshot.agents[root.id][0].id,child.id);
    assert.equal(snapshot.agents[root.id][0].agentRunId,child.agentRunId);
    assert.deepEqual(snapshot.agents[root.id][0].lastTool,{name:'mcp_github_issue_read',state:'completed'});
    const serialized=JSON.stringify(snapshot);
    assert.ok(!serialized.includes('PRIVATE_INTERNAL_CHILD_TRANSCRIPT'));
    assert.ok(!serialized.includes('PRIVATE_DELEGATED_CONTEXT'));
    assert.ok(!serialized.includes(hiddenConversation.id),
      'child session ID must not become an incidental navigation context');
    const listing=await (await fetch(base+'/api/sessions',{headers})).json() as {sessions:Array<{id:string}>};
    assert.deepEqual(listing.sessions.map(s=>s.id),[rootConversation.id]);
  }finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await engine.stop();store.close();
  }
});
