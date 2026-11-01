import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { configuredProviders } from '../src/integrations/manager.js';
import { nativeMcpAllowed, nativeMcpCanInvoke, nativeMcpConfig,
  nativeMcpAuditExtension, type NativeMcpRun } from '../src/pi-native-mcp.js';
import { Store, type Task } from '../src/store.js';

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
