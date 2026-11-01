import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { configuredProviders } from '../src/integrations/manager.js';
import { nativeMcpAllowed, nativeMcpCanInvoke, nativeMcpConfig,
  nativeMcpAuditExtension, type NativeMcpRun } from '../src/pi-native-mcp.js';
import { Store, type Task } from '../src/store.js';
import { Engine, type Limits } from '../src/engine.js';
import { CapabilityRegistry } from '../src/capabilities.js';
import type { Harness } from '../src/harness.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const setup=(child=false)=>{
  const store=new Store(':memory:');
  const conversationId=randomUUID();
  store.save('conversations',{id:conversationId,title:'fixture',createdAt:new Date().toISOString()});
  const task:Task={id:randomUUID(),conversationId,requestId:randomUUID(),prompt:'Read issue #29',
    state:'running',createdAt:new Date().toISOString(),parentId:child?randomUUID():null,
    agentRunId:randomUUID(),dependencies:[],attemptOf:null,result:'',error:null,usage:[],
    ...(child?{delegation:{schemaVersion:1 as const,profile:'researcher' as const,
      toolNames:['mcp__github__issue_read'],modelKey:null,context:'',maxTokens:null,maxCostUsd:null}}:{})};
  store.save('tasks',task);
  let enabled=true;
  const config=configuredProviders({RELAY_GITHUB_TOKEN:'private-do-not-log'})[0];
  const run:NativeMcpRun={store,task,providers:[{config,enabled:()=>enabled}]};
  return {run,store,disable:()=>{enabled=false;}};
};

test('Pi native config exposes only approved GitHub reads with no write privileges',()=>{
  const {run,store}=setup();
  try{
    const config=nativeMcpConfig(run);
    assert.equal(config.servers.length,1);
    const server=config.servers[0].config;
    assert.equal(server.exposure,'hidden');
    assert.equal(server.toolExposure?.issue_read,'deferred');
    assert.equal(server.toolExposure?.create_issue,undefined);
    assert.ok(!JSON.stringify({tools:nativeMcpAllowed(run)}).includes('private-do-not-log'));
    assert.ok(nativeMcpAllowed(run).includes('mcp__github__issue_read'));
    assert.ok(!nativeMcpAllowed(run).includes('mcp__github__create_issue'));
  }finally{store.close();}
});

test('Pi native child inherits only explicit read scope and checks revocation',()=>{
  const {run,store,disable}=setup(true);
  try{
    assert.deepEqual(nativeMcpAllowed(run),['mcp__github__issue_read']);
    assert.equal(nativeMcpCanInvoke(run,'mcp__github__issue_read'),true);
    assert.equal(nativeMcpCanInvoke(run,'mcp__github__search_code'),false);
    assert.equal(nativeMcpCanInvoke(run,'mcp__github__create_issue'),false);
    const changed={...run.task,delegation:{...run.task.delegation!,toolNames:[]}};
    store.save('tasks',changed);
    assert.equal(nativeMcpCanInvoke(run,'mcp__github__issue_read'),false);
    store.save('tasks',run.task);
    disable();
    assert.equal(nativeMcpCanInvoke(run,'mcp__github__issue_read'),false);
  }finally{store.close();}
});

test('Pi native MCP hooks emit durable receipts without leaking arguments or credentials',async()=>{
  const {run,store}=setup(true);
  try{
    const handlers=new Map<string,(e:any)=>unknown>();
    nativeMcpAuditExtension(run).factory({on:(name:string,callback:(e:any)=>unknown)=>{
      handlers.set(name,callback);return ()=>{};
    }} as never);
    const start=handlers.get('tool_call')!,end=handlers.get('tool_result')!;
    const callId='pi-issue-001';
    assert.equal(await start({toolName:'mcp__github__issue_read',toolCallId:callId,
      input:{method:'get',owner:'affank1020',repo:'relay',issue_number:29}}),undefined);
    const stored=store.get('invocations',run.task.id+':'+callId) as {state:string};
    assert.equal(stored.state,'dispatched');
    await end({toolName:'mcp__github__issue_read',toolCallId:callId,isError:false});
    assert.equal((store.get('invocations',run.task.id+':'+callId) as {state:string}).state,'completed');
    assert.deepEqual(store.events(run.task.conversationId).map(e=>e.state),['started','completed']);
    assert.doesNotMatch(JSON.stringify(store.events(run.task.conversationId)),/private-do-not-log|affank1020|issue_number/);
    assert.match(String(JSON.stringify(await start({toolName:'mcp__github__create_issue',toolCallId:'no',
      input:{owner:'affank1020'}}))),/MCP tool not permitted/);
    assert.equal(store.get('invocations',run.task.id+':no'),undefined);
  }finally{store.close();}
});

test('Atlas becomes a trusted native Pi read provider without exposing mutations or tokens',()=>{
  const configs=configuredProviders({
    ATLAS_MCP_URL:'https://atlas.affankhan.dev/mcp',
    ATLAS_MCP_TOKEN:'private-atlas-token',
    RELAY_GITHUB_TOKEN:'private-github-token'
  });
  const atlas=configs.find(p=>p.id==='atlas');
  assert.ok(atlas);
  assert.ok(atlas.readTools.includes('list_nodes'));
  assert.ok(atlas.readTools.includes('list_workspaces'));
  assert.ok(!atlas.readTools.includes('workspace_run_dev_task'));
  const {run,store}=setup();
  try{
    run.providers.push({config:atlas,enabled:()=>true});
    const exposed=nativeMcpAllowed(run);
    assert.ok(exposed.includes('mcp__atlas__list_nodes'));
    assert.ok(!exposed.includes('mcp__atlas__workspace_run_dev_task'));
    const config=nativeMcpConfig(run);
    const server=config.servers.find(p=>p.name==='atlas');
    assert.ok(server);
    assert.equal(server.config.exposure,'hidden');
    assert.equal(server.config.toolExposure?.list_nodes,'deferred');
    assert.equal(server.config.toolExposure?.workspace_run_dev_task,undefined);
    assert.doesNotMatch(JSON.stringify(exposed),/private-atlas-token/);
    assert.match(JSON.stringify(server.config),/private-atlas-token/);
  }finally{store.close();}
});

test('Atlas native endpoint rejects arbitrary cleartext and credentialed URLs',()=>{
  assert.throws(()=>configuredProviders({ATLAS_MCP_URL:'http://malicious.example/mcp'}),
    /trusted local endpoint/);
  assert.throws(()=>configuredProviders({ATLAS_MCP_URL:'https://user:password@atlas.example/mcp'}),
    /trusted local endpoint/);
  assert.doesNotThrow(()=>configuredProviders({
    ATLAS_MCP_URL:'http://atlas:3100/mcp',ATLAS_MCP_TOKEN:''
  }));
});

test('Pi native Atlas tool results preserve safe structured resource observations',async()=>{
  const {run,store}=setup();
  try{
    const configs=configuredProviders({ATLAS_MCP_URL:'https://atlas.affankhan.dev/mcp',
      ATLAS_MCP_TOKEN:'private'});
    run.providers.push({config:configs.find(c=>c.id==='atlas')!,enabled:()=>true});
    const handlers=new Map<string,(e:any)=>unknown>();
    nativeMcpAuditExtension(run).factory({on:(name:string,callback:(event:any)=>unknown)=>{
      handlers.set(name,callback);return ()=>{};
    }} as never);
    const start=handlers.get('tool_call')!,end=handlers.get('tool_result')!;
    assert.equal(await start({toolName:'mcp__atlas__list_nodes',toolCallId:'atlas-check',
      input:{}}),undefined);
    end({toolName:'mcp__atlas__list_nodes',toolCallId:'atlas-check',
      input:{},content:[],structuredContent:{content:[],structuredContent:{result:{nodes:[]}}},isError:false});
    assert.equal((store.get('invocations',run.task.id+':atlas-check') as {state:string}).state,
      'completed');
    assert.ok(store.events(run.task.conversationId).some(e=>e.tool==='atlas:list_nodes' &&
      e.state==='completed'));
    const checkoutId=randomUUID(),nodeId=randomUUID();
    await start({toolName:'mcp__atlas__get_workspace',toolCallId:'workspace',input:{workspaceId:checkoutId}});
    end({toolName:'mcp__atlas__get_workspace',toolCallId:'workspace',input:{workspaceId:checkoutId},content:[],
      structuredContent:{content:[],structuredContent:{result:{id:checkoutId,nodeId,rootPath:'/repo',status:'active'}}},isError:false});
    await start({toolName:'mcp__atlas__workspace_git_status',toolCallId:'git',input:{workspaceId:checkoutId}});
    end({toolName:'mcp__atlas__workspace_git_status',toolCallId:'git',input:{workspaceId:checkoutId},content:[],
      structuredContent:{content:[],structuredContent:{result:{available:true,branch:'main',originRepository:'owner/repo',dirty:false}}},isError:false});
    assert.ok(store.events(run.task.conversationId).some(e=>e.atlasResource?.git?.repository==='owner/repo'));

  }finally{store.close();}
});

test('MCP provider revoked during execution redacts the result and records failure',async()=>{
  const {run,store,disable}=setup();
  try{
    const handlers=new Map<string,(event:any)=>unknown>();
    nativeMcpAuditExtension(run).factory({on:(event:string,cb:(value:any)=>unknown)=>{
      handlers.set(event,cb);return ()=>{};
    }} as never);
    const started=await handlers.get('tool_call')!({toolName:'mcp__github__issue_read',
      toolCallId:'revoked-read',input:{issue_number:29}});
    assert.equal(started,undefined);
    disable();
    const result=await handlers.get('tool_result')!({toolName:'mcp__github__issue_read',
      toolCallId:'revoked-read',input:{issue_number:29},
      isError:false,content:[{type:'text',text:'sensitive data'}]});
    assert.equal((result as {isError:boolean}).isError,true);
    assert.doesNotMatch(JSON.stringify(result),/sensitive data/);
    assert.equal((store.get('invocations',run.task.id+':revoked-read') as {state:string}).state,
      'failed_read');
    assert.ok(store.events(run.task.conversationId).some(e=>e.state==='failed'));
  }finally{store.close();}
});

test('native GitHub writes require exact approval and never become child grants',async()=>{
  const {run,store}=setup();
  let approved=0;
  const args={owner:'affank1020',repo:'relay',issue_number:28,body:'Reviewed text'};
  run.providers[0].config.writeRepositories=['affank1020/relay'];
  run.signal=new AbortController().signal;
  run.approve=async(_task,_id,tool,received)=>{assert.equal(tool,'github:add_issue_comment');assert.deepEqual(received,args);approved++;};
  const handlers=new Map<string,(event:any)=>any>();
  nativeMcpAuditExtension(run).factory({on:(name:string,handler:any)=>handlers.set(name,handler)} as never);
  try{
    assert.ok(nativeMcpAllowed(run).includes('mcp__github__add_issue_comment'));
    assert.equal(await handlers.get('tool_call')!({toolName:'mcp__github__add_issue_comment',toolCallId:'write',input:args}),undefined);
    assert.equal(approved,1);
    assert.equal((store.get('invocations',run.task.id+':write') as any).state,'dispatched');
    handlers.get('tool_result')!({toolName:'mcp__github__add_issue_comment',toolCallId:'write',isError:true});
    assert.equal((store.get('invocations',run.task.id+':write') as any).state,'uncertain');
    const child={...run,task:{...run.task,parentId:'parent'}};
    assert.ok(!nativeMcpAllowed(child).includes('mcp__github__add_issue_comment'));
    assert.ok((await handlers.get('tool_call')!({toolName:'mcp__github__add_issue_comment',toolCallId:'outside',input:{...args,repo:'other'}})).block);
    assert.equal(approved,1);
    run.approve=async()=>{throw new Error('Rejected');};
    assert.ok((await handlers.get('tool_call')!({toolName:'mcp__github__add_issue_comment',toolCallId:'rejected',input:args})).block);
    assert.equal((store.get('invocations',run.task.id+':rejected') as any).state,'denied_before_dispatch');
  }finally{store.close();}
});
