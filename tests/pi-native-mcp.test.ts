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
    assert.equal(start({toolName:'mcp__github__issue_read',toolCallId:callId,
      input:{method:'get',owner:'affank1020',repo:'relay',issue_number:29}}),undefined);
    const stored=store.get('invocations',run.task.id+':'+callId) as {state:string};
    assert.equal(stored.state,'dispatched');
    await end({toolName:'mcp__github__issue_read',toolCallId:callId,isError:false});
    assert.equal((store.get('invocations',run.task.id+':'+callId) as {state:string}).state,'completed');
    assert.deepEqual(store.events(run.task.conversationId).map(e=>e.state),['started','completed']);
    assert.doesNotMatch(JSON.stringify(store.events(run.task.conversationId)),/private-do-not-log|affank1020|issue_number/);
    assert.match(String(JSON.stringify(start({toolName:'mcp__github__create_issue',toolCallId:'no',
      input:{owner:'affank1020'}}))),/MCP tool not permitted/);
    assert.equal(store.get('invocations',run.task.id+':no'),undefined);
  }finally{store.close();}
});

test('opt-in Engine uses Pi native read names for scoped children and omits legacy transport',async()=>{
  const prior=process.env.RELAY_PI_NATIVE_MCP;
  process.env.RELAY_PI_NATIVE_MCP='1';
  const folder=await mkdtemp(join(tmpdir(),'relay-native-mcp-engine-'));
  const store=new Store(':memory:');
  const registry=new CapabilityRegistry(folder,join(process.cwd(),'skills'),
    configuredProviders({RELAY_GITHUB_TOKEN:'private-test'}),()=>({
      list:async()=>{throw Error('legacy read discovery must not run');},
      call:async()=>{throw Error('legacy read transport must not run');},
      close:async()=>{}
    }));
  const limits:Limits={concurrency:2,queue:64,sessionUsd:0,globalUsd:0,
    sessionTokens:0,reserveUsd:0,maxRunMs:5000};
  const seen:string[]=[];
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root native'){
        assert.ok(request.nativeMcp);
        assert.ok(!request.tools.some(t=>t.name==='mcp_github_issue_read'));
        assert.ok(nativeMcpAllowed(request.nativeMcp).includes('mcp__github__issue_read'));
        const schema=JSON.stringify(request.tools.find(t=>t.name==='relay_delegate')!.parameters);
        assert.match(schema,/mcp__github__issue_read/);
        const delegate=request.tools.find(t=>t.name==='relay_delegate')!;
        await delegate.execute('n-1',{prompt:'Read GitHub issue #29',profile:'researcher',
          requiredToolProvider:'github',tools:['mcp__github__issue_read']},
          request.signal,undefined,{} as never);
        return 'Research delegated.';
      }
      if(request.task.kind==='join'){
        assert.equal(request.nativeMcp,undefined);
        return 'Combined one verified read.';
      }
      if(request.task.prompt.startsWith('Read GitHub issue #29')){
        assert.ok(request.nativeMcp);
        assert.deepEqual(nativeMcpAllowed(request.nativeMcp),['mcp__github__issue_read']);
        assert.ok(!request.tools.some(t=>t.name.startsWith('mcp_github_')));
        seen.push('child');
        return JSON.stringify({relayHandoff:{summary:'Source read via native path',
          evidence:[],artifacts:[],openQuestions:[]}});
      }
      throw Error('Unexpected inference task '+request.task.prompt);
    }};
  const engine=new Engine(store,harness,limits,undefined,{},undefined,registry);
  try{
    await registry.update('integrations','github',true);
    const convo=engine.conversation();
    const root=engine.enqueue(convo.id,'root native',randomUUID());
    for(let i=0;i<1000&&store.get<Task>('tasks',root.id)?.state!=='completed';i++)await delay(5);
    assert.equal(store.get<Task>('tasks',root.id)?.state,'completed');
    assert.deepEqual(seen,['child']);
    assert.equal(engine.tasks().filter(t=>t.parentId===root.id).length,1);
  }finally{
    await engine.stop();store.close();await registry.close();
    await rm(folder,{recursive:true,force:true});
    if(prior===undefined)delete process.env.RELAY_PI_NATIVE_MCP;
    else process.env.RELAY_PI_NATIVE_MCP=prior;
  }
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

test('Pi native Atlas tool results preserve safe structured resource observations',()=>{
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
    assert.equal(start({toolName:'mcp__atlas__list_nodes',toolCallId:'atlas-check',
      input:{}}),undefined);
    end({toolName:'mcp__atlas__list_nodes',toolCallId:'atlas-check',
      input:{},content:[],structuredContent:{result:{nodes:[]}},isError:false});
    assert.equal((store.get('invocations',run.task.id+':atlas-check') as {state:string}).state,
      'completed');
    assert.ok(store.events(run.task.conversationId).some(e=>e.tool==='atlas:list_nodes' &&
      e.state==='completed'));
  }finally{store.close();}
});

test('MCP provider revoked during execution redacts the result and records failure',async()=>{
  const {run,store,disable}=setup();
  try{
    const handlers=new Map<string,(event:any)=>unknown>();
    nativeMcpAuditExtension(run).factory({on:(event:string,cb:(value:any)=>unknown)=>{
      handlers.set(event,cb);return ()=>{};
    }} as never);
    const started=handlers.get('tool_call')!({toolName:'mcp__github__issue_read',
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
