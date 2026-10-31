import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createPlatform } from '../src/platform.js';
import { Engine } from '../src/engine.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../src/capabilities.js';
import { ConnectionManager, configuredProviders, type ProviderTransport } from '../src/integrations/manager.js';
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
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();
    await rm(root,{recursive:true,force:true});
  }
});
