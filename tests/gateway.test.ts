import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Gateway, McpTransport, type AtlasTransport } from '../src/gateway.js';
import { Store, type Task, type Approval } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Harness } from '../src/harness.js';

const checkout='59c7c5ad-a3c0-4667-913d-66285303ea51',node='fe7984f9-c7fb-42fd-ac89-4480bc9734a2';
function context(){const store=new Store(':memory:');store.save('conversations',{id:'conversation'});const task={id:'task',conversationId:'conversation'} as Task;return {store,task,signal:new AbortController().signal};}
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:{result:value}});
function transport(call:AtlasTransport['call']):AtlasTransport{return {list:async()=>[],call,close:async()=>{}};}

test('denied tools never dispatch and event metadata excludes arguments/results',async()=>{
  const c=context();let calls=0;const gateway=new Gateway(c.store,transport(async()=>{calls++;return result({secret:'never log'});}),{},async()=>{});
  try{
    await assert.rejects(gateway.invoke(c.task,'denied','archive_project',{secret:'credential'},c.signal),/not permitted/);
    assert.equal(calls,0);
    const response=await gateway.invoke(c.task,'ok','get_atlas_status',{secret:'credential'},c.signal);
    assert.deepEqual(response,result({secret:'never log'}));
    assert.deepEqual(await gateway.invoke(c.task,'ok','get_atlas_status',{secret:'credential'},c.signal),response);
    assert.equal(calls,1);
    assert.doesNotMatch(JSON.stringify(c.store.events('conversation')),/credential|never log/);
    assert.ok(c.store.events('conversation').every(e=>e.executingNodeId===null));
  }finally{c.store.close();}
});

test('capability rejection precedes execution and read-only placement is not execution',async()=>{
  const c=context();const calls:string[]=[];
  const gateway=new Gateway(c.store,transport(async name=>{calls.push(name);return result(name==='get_workspace'?{nodeId:node,status:'active'}:{id:node,status:'online',capabilities:['workspace.files']});}),{[checkout]:['test']},async()=>{});
  try{
    await assert.rejects(gateway.invoke(c.task,'bad','workspace_run_dev_task',{checkoutId:checkout,task:'test'},c.signal));
    assert.ok(!calls.includes('workspace_run_dev_task'));
    await gateway.invoke(c.task,'read','workspace_read_file',{checkoutId:checkout,path:'README.md'},c.signal);
    const event=c.store.events('conversation').filter(e=>e.tool==='workspace_read_file').at(-1)!;
    assert.equal(event.selectedNodeId,node);assert.equal(event.executingNodeId,null);
  }finally{c.store.close();}
});

test('approved named task uses actual execution receipt, and ambiguous failure never retries',async()=>{
  const c=context();let approved=0,executed=0;
  const gateway=new Gateway(c.store,transport(async name=>{
    if(name==='get_workspace')return result({nodeId:node,status:'active'});
    if(name==='get_node')return result({id:node,status:'online',capabilities:['workspace.dev']});
    executed++;return result({workspaceId:checkout,nodeId:node,task:'test',success:true});
  }),{[checkout]:['test']},async(_task,_id,_tool,args)=>{approved++;assert.equal(args.selectedNodeId,node);});
  try{
    const args={checkoutId:checkout,task:'test'};
    await gateway.invoke(c.task,'execute','workspace_run_dev_task',args,c.signal);
    await gateway.invoke(c.task,'execute','workspace_run_dev_task',args,c.signal);
    assert.equal(approved,1);assert.equal(executed,1);
    assert.equal(c.store.events('conversation').at(-1)?.executingNodeId,node);
    let failedCalls=0;const broken=new Gateway(c.store,transport(async()=>{failedCalls++;throw new Error('secret upstream error');}),{},async()=>{});
    await assert.rejects(broken.invoke(c.task,'failure','get_atlas_status',{},c.signal),/Atlas invocation failed/);
    await assert.rejects(broken.invoke(c.task,'failure','get_atlas_status',{},c.signal),/reconciliation/);
    assert.equal(failedCalls,1);assert.doesNotMatch(JSON.stringify(c.store.events('conversation')),/secret upstream/);
  }finally{c.store.close();}
});

test('real MCP HTTP initialize/list/call maps original Atlas result once',async t=>{
  let calls=0;
  const http=createServer(async(req,res)=>{
    const mcp=new McpServer({name:'atlas-protocol-fixture',version:'1'});
    mcp.registerTool('get_atlas_status',{description:'Fixture status',inputSchema:{}},async()=>{calls++;return result({available:true});});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.once('close',()=>{void mcp.close();});
    await mcp.connect(transport);await transport.handleRequest(req,res);
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');const address=http.address();assert.ok(address&&typeof address==='object');
  const client=new McpTransport('http://127.0.0.1:'+address.port+'/mcp','');const c=context();
  t.after(async()=>{await client.close();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));c.store.close();});
  const gateway=new Gateway(c.store,client,{},async()=>{});
  const tools=await gateway.tools(c.task,c.signal);assert.deepEqual(tools.map(t=>t.name),['atlas_get_atlas_status']);
  const actual=await tools[0].execute('call-1',{},c.signal,undefined,{} as never);
  assert.deepEqual(actual.details,result({available:true}));assert.equal(calls,1);
  assert.equal(c.store.events('conversation').at(-1)?.state,'completed');
});

test('approval rejection and cancellation never dispatch the mutation',async()=>{
  for(const action of ['reject','cancel']) {
    const store=new Store(':memory:');let dispatched=false;
    const atlas:AtlasTransport={list:async()=>[{name:'workspace_run_dev_task',inputSchema:{type:'object',properties:{checkoutId:{type:'string'},task:{type:'string'}}}}],close:async()=>{},call:async name=>{
      if(name==='get_workspace')return result({nodeId:node,status:'active'});
      if(name==='get_node')return result({status:'online',capabilities:['workspace.dev']});
      dispatched=true;return result({success:true});
    }};
    const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},run:async r=>{await r.tools[0].execute('mutation',{checkoutId:checkout,task:'test'},r.signal,undefined,{} as never);return '';}};
    const engine=new Engine(store,harness,{concurrency:1,queue:4,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000},atlas,{[checkout]:['test']});
    try{
      const c=engine.conversation(),task=engine.enqueue(c.id,'run test','request-001');
      const end=Date.now()+2000;while(!store.all<Approval>('approvals').length){if(Date.now()>end)assert.fail('Approval not created');await new Promise(r=>setTimeout(r,5));}
      if(action==='reject')engine.decide(store.all<Approval>('approvals')[0].id,false);else await engine.cancel(task.id);
      await engine.stop();assert.equal(dispatched,false);
    }finally{await engine.stop();store.close();}
  }
});

test('delegated workspace read uses private placement checks without exposing their capabilities',async()=>{
  const c=context(),calls:string[]=[];
  c.task.parentId='parent-task-id';
  c.task.delegation={schemaVersion:1,toolNames:['atlas_workspace_read_file'],modelKey:null,
    context:'',maxTokens:null,maxCostUsd:null};
  const gateway=new Gateway(c.store,transport(async name=>{
    calls.push(name);
    if(name==='get_workspace')return result({nodeId:node,status:'active'});
    if(name==='get_node')return result({status:'online',capabilities:['workspace.files']});
    return result({path:'README.md',content:'verified'});
  }),{},async()=>{});
  try{
    const response=await gateway.invoke(c.task,'requested-file','workspace_read_file',
      {checkoutId:checkout,path:'README.md'},c.signal);
    assert.deepEqual(calls,['get_workspace','get_node','workspace_read_file']);
    assert.match(JSON.stringify(response),/verified/);
    await assert.rejects(gateway.invoke(c.task,'direct-node','get_node',{nodeId:node},c.signal),/capability denied/);
    await assert.rejects(gateway.invoke(c.task,'mutation','workspace_run_dev_task',{},c.signal),/capability denied/);
    assert.deepEqual(calls,['get_workspace','get_node','workspace_read_file']);
    assert.equal(c.store.events('conversation').filter(e=>e.tool==='get_node').at(-1)?.state,'completed');
  }finally{c.store.close();}
});
