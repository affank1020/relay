import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createPlatform } from '../src/platform.js';
import { Engine } from '../src/engine.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../src/capabilities.js';
import { ConnectionManager, HttpProviderTransport, configuredProviders, type ProviderTransport } from '../src/integrations/manager.js';
import { validRemoteArguments } from '../src/integrations/schema.js';
import { Store, type Task } from '../src/store.js';
import { PiHarness } from '../src/harness.js';

test('trusted Skills persist enablement and missing packages fail closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-caps-'));
  try{
    let registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
    assert.ok((await registry.list()).skills.every(s=>s.installed&&!s.enabled&&s.revision?.length===64));
    await registry.update('skills','prepare-pr',true);
    await registry.close();
    registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
    assert.deepEqual((await registry.skillPaths()).map(s=>s.name),['prepare-pr']);
    await assert.rejects(registry.update('skills','untrusted',true),/Unknown capability/);
    await registry.close();
    const missing=await CapabilityRegistry.open(root,join(root,'missing'),{});
    assert.deepEqual(await missing.skillPaths(),[]);
    assert.equal((await missing.list()).skills[0].enabled,false);
    await missing.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('malformed persistent policy cannot enable Skills',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-invalid-'));
  try{
    await writeFile(join(root,'capabilities.json'),JSON.stringify({version:1,skills:{'prepare-pr':'yes'},integrations:{}}));
    await assert.rejects(CapabilityRegistry.open(root,join(process.cwd(),'skills'),{}),/refusing to enable/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('configured remote endpoints require explicit host allowlists and GitHub is read only',()=>{
  assert.throws(()=>configuredProviders({RELAY_MCP_PROVIDERS:JSON.stringify([{id:'evil',label:'Evil',url:'http://127.0.0.1:9000',tokenEnv:'RELAY_MCP_TOKEN_EVIL',readTools:['read_docs']}])}),/allowlisted/);
  const providers=configuredProviders({RELAY_GITHUB_TOKEN:'secret'});
  assert.equal(providers.length,1);
  assert.ok(!providers[0].readTools.includes('create_issue'));
});

test('MCP admission, correlated receipts and disable-in-flight are enforced',async()=>{
  const store=new Store(':memory:');
  const conversationId=crypto.randomUUID();
  store.save('conversations',{id:conversationId,title:'test',createdAt:new Date().toISOString()} as {id:string});
  const task={id:crypto.randomUUID(),conversationId} as Task;
  let enabled=true,calls=0;
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'do-not-persist'})[0];
  const fake:ProviderTransport={
    list:async()=>[
      {name:'issue_read',inputSchema:{type:'object',properties:{owner:{type:'string'}},required:['owner'],additionalProperties:false}},
      {name:'create_issue',inputSchema:{type:'object'}}
    ],call:async()=>{calls++;return {content:[{type:'text',text:'sensitive fixture'}]};},close:async()=>{}
  };
  const manager=new ConnectionManager([provider],()=>enabled,()=>fake);
  try{
    const tools=await manager.tools(task,store,new AbortController().signal);
    assert.deepEqual(tools.map(t=>t.name),['mcp_github_issue_read']);
    await tools[0].execute('id-1',{owner:'owner'},new AbortController().signal,undefined,{} as never);
    assert.equal(calls,1);
    assert.deepEqual(store.events(conversationId).map(e=>e.state),['validating','started','completed']);
    assert.doesNotMatch(JSON.stringify(store.events(conversationId)),/do-not-persist|sensitive fixture|owner/);
    enabled=false;
    await assert.rejects(tools[0].execute('id-2',{owner:'owner'},new AbortController().signal,undefined,{} as never),/not permitted/);
    assert.equal(calls,1);
    assert.equal(store.events(conversationId).at(-1)?.state,'denied');
  }finally{await manager.close();store.close();}
});

test('offline provider fails independently and clears inventory',async()=>{
  const store=new Store(':memory:');
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'fixture'})[0];
  const manager=new ConnectionManager([provider],()=>true,()=>({
    list:async()=>{throw new Error('private failure');},call:async()=>{throw new Error('unexpected');},close:async()=>{}
  }));
  try{
    assert.deepEqual(await manager.tools({id:'t',conversationId:'c'} as Task,store,new AbortController().signal),[]);
    assert.equal(manager.list()[0].state,'offline');
    assert.deepEqual(manager.list()[0].availableTools,[]);
  }finally{await manager.close();store.close();}
});

test('real Pi loads only enabled Skills before inference',{timeout:65000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-skill-'));
  const registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
  const controller=new AbortController();
  const task={id:crypto.randomUUID(),conversationId:crypto.randomUUID(),prompt:'no inference',
    state:'running',createdAt:new Date().toISOString()} as Task;
  try{
    await registry.update('skills','prepare-pr',true);
    let observed:string[]=[];
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free',undefined,registry).run({
      version:1,task,tools:[],signal:controller.signal,onText:()=>assert.fail(),onUsage:()=>assert.fail(),
      onSkills:names=>{observed=names;controller.abort(new Error('cancel-after-skill-load'));}
    }),/cancel-after-skill-load/);
    assert.deepEqual(observed,['prepare-pr']);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});


test('delegated child cannot inherit enabled root Skills from Pi resource loader',{timeout:65000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-child-skill-'));
  const registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
  const controller=new AbortController();
  try{
    await registry.update('skills','prepare-pr',true);
    const task:Task={id:crypto.randomUUID(),conversationId:crypto.randomUUID(),prompt:'delegated skill check',
      requestId:'child-skill-check',state:'running',createdAt:new Date().toISOString(),
      parentId:crypto.randomUUID(),dependencies:[],attemptOf:null,result:'',error:null,usage:[],
      delegation:{schemaVersion:1,toolNames:[],modelKey:null,context:'',maxTokens:null,maxCostUsd:null,profile:'reviewer'}};
    let observed:string[]|null=null;
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free',undefined,registry).run({
      version:1,task,tools:[],signal:controller.signal,onText:()=>assert.fail(),onUsage:()=>assert.fail(),
      onSkills:names=>{observed=names;controller.abort(new Error('child-skill-check-complete'));}
    }),/child-skill-check-complete/);
    assert.deepEqual(observed,[]);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});

test('enabled trusted Skill instructions are actually supplied without a file tool',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-skill-content-'));
  try{
    const registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
    assert.equal(await registry.skills.promptContent(),'');
    await registry.update('skills','code-reviewer',true);
    const prompt=await registry.skills.promptContent();
    assert.match(prompt,/<trusted_skill name="code-reviewer">/);
    assert.match(prompt,/Inspect the real current diff/);
    assert.doesNotMatch(prompt,/<trusted_skill name="prepare-pr">/);
    await registry.update('skills','code-reviewer',false);
    assert.equal(await registry.skills.promptContent(),'');
    await registry.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('capability settings API is authenticated, validated and durable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-cap-api-'));
  const registry=await CapabilityRegistry.open(root,join(process.cwd(),'skills'),{});
  const store=new Store(':memory:');
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async()=>''};
  const engine=new Engine(store,harness,{concurrency:1,queue:4,sessionUsd:0,
    globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:1000});
  const accessToken='a'.repeat(32);
  const server=createPlatform(engine,accessToken,join(process.cwd(),'public'),
    'cohere/north-mini-code:free',undefined,registry);
  try{
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    assert.ok(address&&typeof address==='object');
    const url='http://127.0.0.1:'+address.port+'/api/capabilities';
    assert.equal((await fetch(url)).status,401);
    const headers={Authorization:'Bearer '+accessToken,'Content-Type':'application/json'};
    const before=await (await fetch(url,{headers})).json() as {skills:Array<{enabled:boolean}>};
    assert.equal(before.skills[0].enabled,false);
    const invalid=await fetch(url+'/skills/prepare-pr',{method:'PATCH',headers,body:JSON.stringify({enabled:'true'})});
    assert.equal(invalid.status,400);
    const changed=await fetch(url+'/skills/prepare-pr',{method:'PATCH',headers,body:JSON.stringify({enabled:true})});
    assert.equal(changed.status,200);
    assert.equal((await (await fetch(url,{headers})).json() as {skills:Array<{enabled:boolean}>}).skills[0].enabled,true);
    assert.ok((await readFile(join(root,'capabilities.json'),'utf8')).includes('"prepare-pr":true'));
    const session=engine.conversation();
    const reconcileUrl='http://127.0.0.1:'+address.port+'/api/sessions/'+session.id+'/reconcile-mcp-reads';
    assert.equal((await fetch(reconcileUrl,{method:'POST',body:JSON.stringify({confirmed:true})})).status,401);
    assert.equal((await fetch(reconcileUrl,{method:'POST',headers,body:JSON.stringify({confirmed:false})})).status,400);
    const confirmed=await fetch(reconcileUrl,{method:'POST',headers,body:JSON.stringify({confirmed:true})});
    assert.equal(confirmed.status,200);
    assert.deepEqual(await confirmed.json(),{reconciled:0});
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();
    await rm(root,{recursive:true,force:true});
  }
});


test('typeless nested JSON Schema constraints and combinators fail closed',()=>{
  const schema={
    type:'object',properties:{
      filter:{properties:{owner:{type:'string'}},required:['owner'],additionalProperties:false},
      count:{minimum:2,maximum:6},
      tags:{minItems:2,items:{type:'string',maxLength:5}},
      variant:{oneOf:[
        {required:['repo'],properties:{repo:{type:'string'}},additionalProperties:false},
        {required:['issue'],properties:{issue:{type:'integer'}},additionalProperties:false}
      ]}
    },required:['filter'],additionalProperties:false
  };
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},count:3,tags:['a','b'],variant:{repo:'x'}}),true);
  assert.equal(validRemoteArguments(schema,{filter:{owner:42}}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice',other:'unexpected'}}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},count:1}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},tags:['one']}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},tags:['more-than-five','ok']}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},variant:{repo:6}}),false);
  assert.equal(validRemoteArguments(schema,{filter:{owner:'alice'},variant:{unknown:true}}),false);
  assert.equal(validRemoteArguments({...schema,pattern:'unsafe-unimplemented'},{filter:{owner:'alice'}}),false);
});

test('expired established MCP transport reconnects on a later discovery, never replays a failed call',async()=>{
  const config=configuredProviders({RELAY_GITHUB_TOKEN:'fake'})[0];
  let generations=0,closed=0,dispatched=0;
  const provider=new HttpProviderTransport(config,async()=>{
    const version=++generations;
    let discovered=0;
    return {
      listTools:async()=>{
        discovered++;
        if(version===1&&discovered===2)throw new Error('remote session expired: credentials opaque');
        return {tools:[{name:'issue_read',inputSchema:{type:'object'}}]};
      },
      callTool:async()=>{dispatched++;throw new Error('stale session');},
      close:async()=>{closed++;}
    } as never;
  });
  const signal=new AbortController().signal;
  try{
    assert.equal((await provider.list(signal)).length,1);
    await assert.rejects(provider.list(signal),/session expired/);
    assert.equal(closed,1);
    assert.equal((await provider.list(signal)).length,1);
    assert.equal(generations,2);
    await assert.rejects(provider.call('issue_read',{},signal),/stale session/);
    assert.equal(dispatched,1,'no automatic retry of ambiguous calls');
    assert.equal(closed,2);
    assert.equal((await provider.list(signal)).length,1);
    assert.equal(generations,3);
  }finally{await provider.close();}
});

test('known failed MCP read does not prevent conversation deletion',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-read-delete-'));
  const store=new Store(':memory:');
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'private'})[0];
  const registry=new CapabilityRegistry(root,join(process.cwd(),'skills'),[provider],()=>({
    list:async()=>[{name:'issue_read',inputSchema:{type:'object',additionalProperties:false}}],
    call:async()=>({isError:true,content:[{type:'text',text:'secret failure'}]}),
    close:async()=>{}
  }));
  await registry.update('integrations','github',true);
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},
    deleteConversationSessions:async()=>{},
    run:async(req:import('../src/harness.js').HarnessRequest)=>{
      const tool=req.tools.find(t=>t.name==='mcp_github_issue_read');
      assert.ok(tool);
      await assert.rejects(tool.execute('known-failure',{},req.signal,undefined,{} as never),/MCP read failed/);
      return 'could not read the issue';
    }};
  const engine=new Engine(store,harness,{concurrency:1,queue:10,sessionUsd:0,globalUsd:0,
    sessionTokens:0,reserveUsd:0,maxRunMs:10000},undefined,{},undefined,registry);
  try{
    const session=engine.conversation();
    const task=engine.enqueue(session.id,'Read an issue','read-error-001');
    const end=Date.now()+4000;
    while(engine.tasks().find(t=>t.id===task.id)?.state!=='completed'){
      if(Date.now()>end)throw new Error('Task not completed');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.deepEqual(store.invocationStates(task.id),['failed_read']);
    await engine.deleteConversation(session.id);
    assert.equal(store.get('conversations',session.id),undefined);
  }finally{await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});}
});

test('uncertain MCP reads need explicit reconciliation; Atlas uncertainties cannot be retired',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-read-reconcile-'));
  const store=new Store(':memory:');
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'private'})[0];
  const registry=new CapabilityRegistry(root,join(process.cwd(),'skills'),[provider],()=>({
    list:async()=>[{name:'issue_read',inputSchema:{type:'object',additionalProperties:false}}],
    call:async()=>{throw new Error('connection lost after dispatch');},
    close:async()=>{}
  }));
  await registry.update('integrations','github',true);
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},
    deleteConversationSessions:async()=>{},
    run:async(req:import('../src/harness.js').HarnessRequest)=>{
      const tool=req.tools.find(t=>t.name==='mcp_github_issue_read')!;
      await assert.rejects(tool.execute('ambiguous-read',{},req.signal,undefined,{} as never),/uncertain/);
      return 'outcome unknown';
    }};
  const engine=new Engine(store,harness,{concurrency:1,queue:10,sessionUsd:0,globalUsd:0,
    sessionTokens:0,reserveUsd:0,maxRunMs:10000},undefined,{},undefined,registry);
  try{
    const c=engine.conversation();
    const task=engine.enqueue(c.id,'Read issue','read-unknown-001');
    const end=Date.now()+4000;
    while(engine.tasks().find(t=>t.id===task.id)?.state!=='completed'){
      if(Date.now()>end)throw new Error('Task not completed');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.deepEqual(store.invocationStates(task.id),['uncertain']);
    await assert.rejects(engine.deleteConversation(c.id),/uncertain read-only MCP invocations/);
    assert.throws(()=>engine.reconcileMcpReadInvocations(c.id,false),/confirmation/);
    // An Atlas-style uncertain operation is never eligible for read-only reconciliation.
    store.save('invocations',{id:task.id+':atlas-test',state:'uncertain'});
    assert.throws(()=>engine.reconcileMcpReadInvocations(c.id,true),/uncertain tool invocations/);
    assert.deepEqual(store.invocationStates(task.id).sort(),['uncertain','uncertain']);
    store.db.prepare('DELETE FROM invocations WHERE id=?').run(task.id+':atlas-test');
    assert.equal(engine.reconcileMcpReadInvocations(c.id,true),1);
    assert.deepEqual(store.invocationStates(task.id),['reconciled_read']);
    assert.equal(store.events(c.id).at(-1)?.type,'reconciliation');
    await engine.deleteConversation(c.id);
    assert.equal(store.get('conversations',c.id),undefined);
    const retained=store.db.prepare('SELECT read_count,acknowledged_at FROM retired_read_reconciliations WHERE conversation_id=?')
      .get(c.id) as {read_count:number;acknowledged_at:string}|undefined;
    assert.equal(retained?.read_count,1);
    assert.ok(retained?.acknowledged_at);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE conversation_id=?').get(c.id)?.n,0);
    const schema=store.db.prepare("SELECT sql FROM sqlite_master WHERE name='retired_read_reconciliations'").get() as {sql:string};
    assert.doesNotMatch(schema.sql,/args|result|prompt|tool_name|invocation_id/);
  }finally{await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});}
});

test('one failed MCP RPC does not terminate another agent sharing the client',async()=>{
  const config=configuredProviders({RELAY_GITHUB_TOKEN:'fake'})[0];
  let generations=0,closed=0,dispatches=0;
  let firstStarted!:()=>void,secondStarted!:()=>void;
  const firstEntered=new Promise<void>(resolve=>{firstStarted=resolve;});
  const secondEntered=new Promise<void>(resolve=>{secondStarted=resolve;});
  let failFirst!:()=>void,finishSecond!:()=>void;
  const firstGate=new Promise<void>(resolve=>{failFirst=resolve;});
  const secondGate=new Promise<void>(resolve=>{finishSecond=resolve;});
  let unexpectedlyClosed=false;
  const provider=new HttpProviderTransport(config,async()=>{
    generations++;
    let open=true;
    return {
      listTools:async()=>({tools:[{name:'issue_read',inputSchema:{type:'object'}}]}),
      callTool:async()=>{
        dispatches++;
        if(dispatches===1){
          firstStarted();
          await firstGate;
          throw new Error('first RPC timed out');
        }
        secondStarted();
        await secondGate;
        if(!open)throw new Error('peer connection was closed');
        return {content:[{type:'text',text:'second completed'}]};
      },
      close:async()=>{
        closed++;
        if(!open)throw new Error('duplicate close');
        open=false;
        unexpectedlyClosed=true;
      }
    } as never;
  });
  const signal=new AbortController().signal;
  try{
    const first=provider.call('issue_read',{id:1},signal);
    await firstEntered;
    const second=provider.call('issue_read',{id:2},signal);
    await secondEntered;
    failFirst();
    await assert.rejects(first,/first RPC timed out/);
    assert.equal(closed,0,'must keep connection open while peer is in flight');
    assert.equal(unexpectedlyClosed,false);
    finishSecond();
    assert.deepEqual(await second,{content:[{type:'text',text:'second completed'}]});
    assert.equal(closed,1,'stale session closes after all peers finish');
    assert.equal(dispatches,2,'each call dispatched once, never silently retried');
    assert.equal((await provider.list(signal)).length,1);
    assert.equal(generations,2,'next discovery gets a fresh connection');
  }finally{await provider.close();}
});

test('minimal MCP reconciliation audit survives durable conversation deletion and restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-retired-reads-'));
  const dbPath=join(root,'relay.sqlite');
  const id=crypto.randomUUID(),taskId=crypto.randomUUID();
  const task={
    id:taskId,conversationId:id,requestId:'durable-test',prompt:'sensitive prompt',
    state:'completed',createdAt:new Date().toISOString(),parentId:null,
    dependencies:[],attemptOf:null,result:'sensitive output',error:null,usage:[]
  } as Task;
  let store=new Store(dbPath);
  try{
    store.save('conversations',{id,title:'sensitive title',createdAt:new Date().toISOString()});
    store.save('tasks',task);
    store.save('invocations',{id:taskId+':read',kind:'mcp_read',state:'reconciled_read',
      toolName:'mcp_github_issue_read',invocationId:crypto.randomUUID(),reconciledAt:'2026-10-31T21:00:00.000Z'});
    store.event(id,{taskId,type:'reconciliation',state:'read_reconciled'});
    store.purgeConversation(id,[task]);
    store.checkpointDeletedHistory();
    store.close();
    store=new Store(dbPath);
    const receipt=store.db.prepare('SELECT * FROM retired_read_reconciliations WHERE conversation_id=?')
      .get(id) as {conversation_id:string;read_count:number;acknowledged_at:string}|undefined;
    assert.deepEqual({...receipt},{conversation_id:id,read_count:1,acknowledged_at:'2026-10-31T21:00:00.000Z'});
    assert.equal(store.get('conversations',id),undefined);
    assert.deepEqual(store.events(id),[]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()?.count,0);
    assert.doesNotMatch(JSON.stringify(receipt),/sensitive|mcp_github_issue_read/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
