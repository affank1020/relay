import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Task } from '../src/store.js';
import { Engine, type Limits } from '../src/engine.js';
import { createPlatform } from '../src/platform.js';
import { AtlasContextError, AtlasContextService, atlasList, formatAtlasContext } from '../src/atlas-context.js';
import type { AtlasTransport } from '../src/gateway.js';
import type { Harness, HarnessRequest } from '../src/harness.js';

const projectId='f81b5f68-5a1b-414f-949d-9af62977387d';
const otherId='d99a6c45-a4ec-5ef6-8f22-c07d31f8bb38';
const checkoutId='df1c2c81-1383-4533-92ed-b512dbd5646b';
const logicalId='4d2c2103-360b-4913-8240-f9767de1bd48';
const nodeId='fe7984f9-c7fb-42fd-ac89-4480bc9734a2';
const limits:Limits={concurrency:1,queue:16,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000};
const mcp=(value:unknown)=>({structuredContent:{result:value},content:[{type:'text',text:JSON.stringify(value)}]});
const projectList=[{id:projectId,name:'Atlas <script>'},{id:otherId,name:'Portfolio'}];
const checkoutList=[{id:checkoutId,projectId,logicalWorkspaceId:logicalId,nodeId,name:'Atlas Mac',status:'active'}];
const otherCheckoutId='95769f0d-5ee1-41f4-afb8-c1c9fbc4d175';
const otherCheckout={id:otherCheckoutId,projectId:otherId,logicalWorkspaceId:logicalId,nodeId,name:'Portfolio checkout',status:'active'};
// The Atlas MCP may return both physical checkouts of a shared logical Workspace.
const sharedWorkspaceRows=[...checkoutList,otherCheckout];
function mockAtlas():AtlasTransport&{requests:string[]} {
  const requests:string[]=[];
  return {requests,list:async()=>[],close:async()=>{},call:async(name,args)=>{
    requests.push(name);
    if(name==='list_projects')return mcp(projectList);
    if(name==='list_project_workspaces')return mcp(args.projectId===projectId||args.projectId===otherId?sharedWorkspaceRows:[]);
    throw Error('Only selector reads are allowed in this fixture');
  }};
}
const harness=(run:(r:HarnessRequest)=>Promise<string>):Harness=>({version:1,capabilities:{persistence:true,cancellation:true,tools:true},run});
async function until(predicate:()=>boolean) {
  const end=Date.now()+3000;
  while(!predicate()) {if(Date.now()>end)assert.fail('Timed out');await new Promise(r=>setTimeout(r,5));}
}

test('MCP structured array contract, validation, project membership, and untrusted names',async()=>{
  const atlas=mockAtlas(),svc=new AtlasContextService(atlas);
  assert.deepEqual((await svc.projects()).map(p=>p.id),[projectId,otherId]);
  const checkouts=await svc.checkouts(projectId);
  assert.equal(checkouts[0].checkoutId,checkoutId);
  assert.equal(checkouts[0].logicalWorkspaceId,logicalId);
  assert.equal(checkouts[0].nodeId,nodeId);
  assert.deepEqual(checkouts.map(c=>c.checkoutId),[checkoutId],'mixed-project results must expose only selected project');
  assert.equal(checkouts[0].projectId,projectId,'membership must come from the original checkout row');
  const otherCheckouts=await svc.checkouts(otherId);
  assert.deepEqual(otherCheckouts.map(c=>c.checkoutId),[otherCheckoutId]);
  assert.equal(otherCheckouts[0].projectId,otherId);
  const pinned=await svc.validate(projectId,checkoutId);
  assert.equal(pinned?.checkoutName,'Atlas Mac');
  assert.match(formatAtlasContext(pinned),/physicalCheckout/);
  assert.match(formatAtlasContext(pinned),/untrusted data/);
  assert.equal(await svc.validate(null,null),null);
  assert.equal(atlas.requests.includes('get_node'),false,'selection cannot imply live node status');
  await assert.rejects(svc.validate(otherId,checkoutId),(e:unknown)=>e instanceof AtlasContextError&&e.status===409);
  await assert.rejects(svc.validate(projectId,otherCheckoutId),(e:unknown)=>e instanceof AtlasContextError&&e.status===409);
  assert.equal((await svc.validate(otherId,otherCheckoutId))?.checkoutId,otherCheckoutId);
  await assert.rejects(svc.validate('bad',null),(e:unknown)=>e instanceof AtlasContextError&&e.status===400);
  await assert.rejects(svc.validate(null,checkoutId),(e:unknown)=>e instanceof AtlasContextError&&e.status===400);
  assert.equal(atlasList(mcp([])).length,0);
  assert.throws(()=>atlasList(mcp({items:[]})),/unsupported response/);
  const mixed=mockAtlas();mixed.call=async name=>name==='list_projects'?mcp(projectList):mcp([...checkoutList,{...checkoutList[0],id:otherId,status:'inactive'}]);
  const active=await new AtlasContextService(mixed).checkouts(projectId);
  assert.deepEqual(active.map(w=>w.checkoutId),[checkoutId],'inactive checkout must not block otherwise valid discovery');
  await assert.rejects(new AtlasContextService(mixed).validate(projectId,otherId),/no longer associated/);
  const denied=mockAtlas();denied.call=async()=>{throw Error('403 Forbidden');};
  await assert.rejects(new AtlasContextService(denied).projects(),(e:unknown)=>e instanceof AtlasContextError&&e.status===403&&e.message==='Atlas access denied');
  assert.throws(()=>atlasList({isError:true,content:[{type:'text',text:'Permission denied'}]}),(e:unknown)=>e instanceof AtlasContextError&&e.status===403);
  const foreignOnly=mockAtlas();
  foreignOnly.call=async name=>name==='list_projects'?mcp(projectList):mcp([{...checkoutList[0],projectId:otherId}]);
  assert.deepEqual(await new AtlasContextService(foreignOnly).checkouts(projectId),[]);
  await assert.rejects(new AtlasContextService(foreignOnly).validate(projectId,checkoutId),
    (e:unknown)=>e instanceof AtlasContextError&&e.status===409);
  const unavailable=mockAtlas();unavailable.call=async()=>{throw Error('Bearer secret PRIVATE');};
  await assert.rejects(new AtlasContextService(unavailable).projects(),(e:unknown)=>
    e instanceof AtlasContextError&&e.status===503&&!e.message.includes('secret'));
});

test('context lives in its own conversation, freezes at enqueue, survives restart and retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-atlas-context-'));
  let store=new Store(join(directory,'db.sqlite'));
  const requests:HarnessRequest[]=[];
  const agent=harness(async req=>{requests.push(req);throw Error('controlled failure');});
  let engine=new Engine(store,agent,limits,mockAtlas());
  try {
    const first=engine.conversation(),second=engine.conversation();
    assert.equal(first.atlasContext,undefined);
    const selected=await engine.updateContext(first.id,projectId,checkoutId);
    assert.equal(selected.atlasContext?.checkoutId,checkoutId);
    assert.equal(store.get<{atlasContext?:unknown}>('conversations',second.id)?.atlasContext,undefined);
    const task=engine.enqueue(first.id,'work on checkout','context-enqueue-001');
    await until(()=>engine.tasks().find(t=>t.id===task.id)?.state==='failed');
    assert.equal(requests[0].atlasContext?.checkoutId,checkoutId);
    assert.equal(requests[0].atlasContext?.logicalWorkspaceId,logicalId);
    assert.equal(requests[0].atlasAvailable,false);
    await engine.updateContext(first.id,projectId,null);
    assert.equal(engine.tasks().find(t=>t.id===task.id)?.atlasContext?.checkoutId,checkoutId);
    const retry=engine.retry(task.id,true);
    await until(()=>engine.tasks().find(t=>t.id===retry.id)?.state==='failed');
    assert.equal(requests[1].atlasContext?.checkoutId,checkoutId);
    assert.equal(store.get<{atlasContext?:{checkoutId:string|null}}> ('conversations',retry.conversationId)?.atlasContext?.checkoutId,checkoutId);
    await engine.stop();store.close();
    store=new Store(join(directory,'db.sqlite'));engine=new Engine(store,agent,limits,mockAtlas());
    assert.equal(store.get<{atlasContext?:{checkoutId:string|null}}> ('conversations',first.id)?.atlasContext?.checkoutId,null);
    assert.equal(store.get<{atlasContext?:{checkoutId:string|null}}> ('conversations',retry.conversationId)?.atlasContext?.checkoutId,checkoutId);
  } finally {await engine.stop();store.close();await rm(directory,{recursive:true,force:true});}
});

test('active task locks context changes while a different conversation remains independent',async()=>{
  const store=new Store(':memory:');
  let release!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const engine=new Engine(store,harness(async()=>{await hold;return 'done';}),limits,mockAtlas());
  try{
    const one=engine.conversation(),two=engine.conversation();
    await engine.updateContext(one.id,projectId,checkoutId);
    engine.enqueue(one.id,'running','context-busy-001');
    await until(()=>engine.tasks()[0].state==='running');
    await assert.rejects(engine.updateContext(one.id,null,null),/active task/);
    assert.equal((await engine.updateContext(two.id,otherId,null)).atlasContext?.projectId,otherId);
    assert.equal(engine.store.get<{atlasContext?:{checkoutId:string|null}}>('conversations',one.id)?.atlasContext?.checkoutId,checkoutId);
  } finally {release();await engine.stop();store.close();}
});

test('offline Atlas discovery does not prevent ordinary inference',async()=>{
  const store=new Store(':memory:');let called=false;
  const atlas:AtlasTransport={call:async()=>{throw Error('secret Atlas offline');},list:async()=>{throw Error('Atlas offline');},close:async()=>{}};
  const engine=new Engine(store,harness(async req=>{called=true;assert.deepEqual(req.tools.map(t=>t.name),[]);assert.equal(req.atlasAvailable,false);return 'ordinary reply';}),limits,atlas);
  try {const c=engine.conversation();engine.enqueue(c.id,'ordinary text','offline-atlas-001');
    await until(()=>engine.tasks()[0].state==='completed');
    assert.equal(called,true);
    assert.equal(engine.tasks()[0].result,'ordinary reply');
  } finally {await engine.stop();store.close();}
});

test('authenticated Atlas context routes reject invalid and cross-project state, and retain persisted names',async()=>{
  const store=new Store(':memory:');
  const engine=new Engine(store,harness(async()=> 'done'),limits,mockAtlas());
  const server=createPlatform(engine,'a'.repeat(32),'/tmp','cohere/north-mini-code:free');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const url='http://127.0.0.1:'+address.port;
  const request=(path:string,method='GET',data?:unknown,auth=true)=>
    fetch(url+'/api'+path,{method,headers:{...(auth?{Authorization:'Bearer '+'a'.repeat(32)}:{}),
      ...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  try {
    const c=engine.conversation();
    assert.equal((await request('/atlas/context/projects','GET',undefined,false)).status,401);
    const projects=await request('/atlas/context/projects');
    assert.equal(projects.status,200);assert.equal(((await projects.json()) as {projects:unknown[]}).projects.length,2);
    const list=await request('/atlas/context/projects/'+projectId+'/checkouts');
    assert.equal(list.status,200);
    const own=(await list.json()) as {checkouts:Array<{checkoutId:string;projectId:string}>};
    assert.deepEqual(own.checkouts.map(c=>c.checkoutId),[checkoutId]);
    assert.ok(own.checkouts.every(c=>c.projectId===projectId));
    const otherList=await request('/atlas/context/projects/'+otherId+'/checkouts');
    assert.equal(otherList.status,200);
    const others=(await otherList.json()) as {checkouts:Array<{checkoutId:string;projectId:string}>};
    assert.deepEqual(others.checkouts.map(c=>c.checkoutId),[otherCheckoutId]);
    assert.ok(others.checkouts.every(c=>c.projectId===otherId));
    const path='/sessions/'+c.id+'/context';
    assert.equal((await request(path,'PATCH',{projectId,checkoutId:otherId})).status,409);
    assert.equal((await request(path,'PATCH',{projectId,checkoutId:otherCheckoutId})).status,409);
    assert.equal((await request(path,'PATCH',{projectId:otherId,checkoutId})).status,409);
    assert.equal((await request(path,'PATCH',{projectId:null,checkoutId})).status,400);
    assert.equal((await request(path,'PATCH',{projectId,checkoutId,token:'secret'})).status,400);
    const saved=await request(path,'PATCH',{projectId,checkoutId});
    assert.equal(saved.status,200);
    const snapshot=await (await request('/sessions/'+c.id)).json() as {session:{atlasContext:{checkoutName:string}}};
    assert.equal(snapshot.session.atlasContext.checkoutName,'Atlas Mac');
    assert.equal((await request(path,'PATCH',{projectId:null,checkoutId:null})).status,200);
    assert.equal(store.get<{atlasContext:unknown}>('conversations',c.id)?.atlasContext,null);
  } finally {await engine.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
