import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
