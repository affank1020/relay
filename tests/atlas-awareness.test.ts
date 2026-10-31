import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeAtlasResult, projectAtlasCheckouts } from '../src/atlas-awareness.js';
import { Gateway, type AtlasTransport } from '../src/gateway.js';
import { Store, type Task } from '../src/store.js';

const checkout='59c7c5ad-a3c0-4667-913d-66285303ea51';
const another='663e945b-1b55-497e-8d5f-42f185c7027c';
const mac='fe7984f9-c7fb-42fd-ac89-4480bc9734a2';
const linux='3aa1cb36-5f49-464b-ae53-732ab849865b';
const result=(value:unknown)=>({content:[{type:'text' as const,text:'UNTRUSTED text with password=secret'}],structuredContent:{result:value}});
function fixture(nodeStatus:'online'|'offline'='online'):AtlasTransport {
  return {
    list:async()=>[],close:async()=>{},
    call:async (name,args)=>{
      const id=args.checkoutId as string;
      if(name==='get_workspace')return result({id,name:id===checkout?'Relay (Mac)':'Relay Linux',
        logicalWorkspaceId:another,nodeId:id===checkout?mac:linux,
        rootPath:id===checkout?'/Users/example/relay':'/srv/atlas/workspaces/relay',
        status:'active'});
      if(name==='get_node')return result({id:args.nodeId,name:args.nodeId===mac?'Mac':'Linux',
        status:nodeStatus,capabilities:['workspace.git','workspace.files']});
      if(name==='workspace_git_status')return result({available:true,branch:id===checkout?'atlas/feature':'main',
        head:'58ad284074c3f241dce0ccf716c7caed4f2b0fb7',
        originRepository:'affank1020/relay',dirty:id===checkout,
        changes:id===checkout?[{path:'README.md'}]:[]});
      if(name==='workspace_git_list_worktrees')return result({worktrees:[{
        rootPath:'/Users/example/relay',branch:'atlas/feature',head:'58ad284074c3f241dce0ccf716c7caed4f2b0fb7'}]});
      throw Error('Not supported');
    }
  };
}
function task(conversationId='conv'):Task {
  return {id:'task',agentRunId:'child-run',conversationId} as Task & {agentRunId:string};
}
function project(store:Store,conversationId='conv') {
  return projectAtlasCheckouts(store.events(conversationId));
}

test('Atlas fact parser rejects arbitrary text and mismatched identities',()=>{
  assert.equal(observeAtlasResult('get_workspace',{checkoutId:checkout},{id:another,nodeId:mac}),null);
  assert.equal(observeAtlasResult('get_workspace',{checkoutId:checkout},null),null);
  assert.equal(observeAtlasResult('workspace_git_status',{checkoutId:checkout},
    {available:true,branch:'main'},undefined),null);
  assert.equal(observeAtlasResult('workspace_read_file',{checkoutId:checkout},
    {text:'private file body'},undefined),null);
  const parsed=observeAtlasResult('get_workspace',{checkoutId:checkout},{
    id:checkout,status:'active',rootPath:'/home/me/work',name:'Project\nsecret',nodeId:mac,
    token:'top-secret'});
  assert.equal(parsed?.checkout?.name,undefined);
  assert.equal(parsed?.checkout?.rootPath,'/home/me/work');
  assert.doesNotMatch(JSON.stringify(parsed),/top-secret|\\nsecret/);
});

test('checkout, assigned Node and Git state come from successful Atlas receipts',async()=>{
  const store=new Store(':memory:');store.save('conversations',{id:'conv'});
  const gateway=new Gateway(store,fixture(),{},async()=>{});
  try{
    const args={checkoutId:checkout};
    await gateway.invoke(task(),'call','workspace_git_status',args,new AbortController().signal);
    const projected=project(store);
    assert.equal(projected.length,1);
    assert.equal(projected[0].checkoutId,checkout);
    assert.equal(projected[0].rootPath,'/Users/example/relay');
    assert.equal(projected[0].nodeId,mac);
    assert.equal(projected[0].nodeName,'Mac');
    assert.equal(projected[0].branch,'atlas/feature');
    assert.equal(projected[0].repository,'affank1020/relay');
    assert.equal(projected[0].dirty,true);
    assert.equal(projected[0].changedFiles,1);
    assert.equal(projected[0].agentRunId,'child-run');
    const events=store.events('conv');
    assert.equal(events.filter(e=>e.type==='atlas_resource').length,3);
    assert.ok(events.filter(e=>e.type==='atlas_resource').every(e=>e.agentRunId==='child-run'));
    assert.ok(events.every(e=>e.executingNodeId===null));
    assert.doesNotMatch(JSON.stringify(events),/UNTRUSTED|password=|top-secret/);
    const count=events.length;
    await gateway.invoke(task(),'call','workspace_git_status',args,new AbortController().signal);
    assert.equal(store.events('conv').length,count,'idempotent replay does not emit again');
  }finally{store.close();}
});

test('multiple checkouts and Nodes remain distinct, replay is deduplicated',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-awareness-'));
  const db=join(root,'relay.sqlite');
  try{
    const store=new Store(db);store.save('conversations',{id:'conv'});
    const gateway=new Gateway(store,fixture(),{},async()=>{});
    await gateway.invoke(task(),'mac','workspace_git_status',{checkoutId:checkout},new AbortController().signal);
    await gateway.invoke(task(),'linux','workspace_git_status',{checkoutId:another},new AbortController().signal);
    const events=store.events('conv');
    assert.equal(projectAtlasCheckouts([...events,...events]).length,2);
    store.close();
    const reloaded=new Store(db);
    try{
      const views=project(reloaded);
      assert.equal(views.length,2);
      assert.deepEqual(views.map(v=>v.nodeId).sort(),[mac,linux].sort());
      assert.equal(views.find(v=>v.checkoutId===another)?.dirty,false);
      assert.equal(project(reloaded,'missing-conversation').length,0);
    }finally{reloaded.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a reassigned checkout cannot inherit Git state from a previous Node',async()=>{
  const store=new Store(':memory:');store.save('conversations',{id:'conv'});
  const gateway=new Gateway(store,fixture(),{},async()=>{});
  try{
    await gateway.invoke(task(),'git-before-move','workspace_git_status',
      {checkoutId:checkout},new AbortController().signal);
    assert.equal(project(store)[0].branch,'atlas/feature');
    const moved=observeAtlasResult('get_workspace',{checkoutId:checkout},{
      id:checkout,rootPath:'/srv/new-relay',nodeId:linux,status:'active'});
    assert.ok(moved);
    store.event('conv',{taskId:'task',agentRunId:'child-run',invocationId:'move',
      tool:'get_workspace',type:'atlas_resource',state:'completed',workspaceId:checkout,
      atlasResource:moved});
    const view=project(store)[0];
    assert.equal(view.nodeId,linux);
    assert.equal(view.branch,undefined);
    assert.equal(view.gitObservedAt,undefined);
    assert.equal(view.rootPath,'/srv/new-relay');
  }finally{store.close();}
});

test('offline Node blocks Git inspection; placement is not execution',async()=>{
  const store=new Store(':memory:');store.save('conversations',{id:'conv'});
  const gateway=new Gateway(store,fixture('offline'),{},async()=>{});
  try{
    await assert.rejects(gateway.invoke(task(),'offline','workspace_git_status',
      {checkoutId:checkout},new AbortController().signal),/Atlas invocation failed/);
    const view=project(store)[0];
    assert.equal(view.nodeStatus,'offline');
    assert.equal(view.nodeId,mac);
    assert.equal(view.branch,undefined);
    assert.ok(view.lastFailureAt);
    assert.ok(store.events('conv').every(e=>e.executingNodeId===null));
  }finally{store.close();}
});

test('read-only worktree operation produces scoped, bounded worktree facts',async()=>{
  const store=new Store(':memory:');store.save('conversations',{id:'conv'});
  const gateway=new Gateway(store,fixture(),{},async()=>{});
  try{
    await gateway.invoke(task(),'trees','workspace_git_list_worktrees',
      {checkoutId:checkout},new AbortController().signal);
    const tree=project(store)[0].worktrees?.[0];
    assert.equal(tree?.id,mac+':/Users/example/relay');
    assert.equal(tree?.branch,'atlas/feature');
    assert.equal(tree?.rootPath,'/Users/example/relay');
  }finally{store.close();}
});

test('ordinary conversations and denied operations never manufacture observations',async()=>{
  const store=new Store(':memory:');store.save('conversations',{id:'conv'});
  const gateway=new Gateway(store,fixture(),{},async()=>{});
  try{
    assert.deepEqual(project(store),[]);
    await assert.rejects(gateway.invoke(task(),'deny','workspace_git_create_branch',
      {checkoutId:checkout,branch:'atlas/nope'},new AbortController().signal),/not permitted/);
    assert.deepEqual(project(store),[]);
  }finally{store.close();}
});
