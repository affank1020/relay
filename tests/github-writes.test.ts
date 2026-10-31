import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { githubWriteRepositories, approvedGitHubWriteArgs } from '../src/integrations/github-writes.js';
import { configuredProviders, ConnectionManager, type ProviderTransport } from '../src/integrations/manager.js';
import { CapabilityRegistry } from '../src/capabilities.js';
import { Engine } from '../src/engine.js';
import { Store, type Task, type Approval } from '../src/store.js';
import { createPlatform } from '../src/platform.js';
import type { HarnessRequest } from '../src/harness.js';

const issueCommentSchema:Record<string,unknown>={type:'object',properties:{
  owner:{type:'string'},repo:{type:'string'},issue_number:{type:'integer'},body:{type:'string'}
},required:['owner','repo','issue_number','body'],additionalProperties:false};
const createIssueSchema:Record<string,unknown>={type:'object',properties:{
  owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'}
},required:['owner','repo','title'],additionalProperties:false};
const both=[
  {name:'issue_read',inputSchema:{type:'object',additionalProperties:false}},
  {name:'add_issue_comment',inputSchema:issueCommentSchema},
  {name:'create_issue',inputSchema:createIssueSchema},
  {name:'push_files',inputSchema:{type:'object',additionalProperties:false}}
];
const argumentsForComment={owner:'affank1020',repo:'relay',issue_number:28,body:'Explicitly approved discussion'};
const comment=(manager:ConnectionManager,task:Task,store:Store,signal:AbortSignal,
  approve?:Parameters<ConnectionManager['tools']>[3])=>
    manager.tools(task,store,signal,approve);
const taskFixture=(store:Store):Task=>{
  const conversationId=randomUUID(),id=randomUUID();
  store.save('conversations',{id:conversationId,title:'GitHub',createdAt:new Date().toISOString()});
  return {id,conversationId,agentRunId:randomUUID(),agentId:randomUUID(),
    prompt:'Post a comment',state:'running',createdAt:new Date().toISOString(),
    requestId:'write-'+randomUUID(),parentId:null,dependencies:[],attemptOf:null,
    result:'',error:null,usage:[]};
};
async function waitFor(predicate:()=>boolean,description:string) {
  const until=Date.now()+5000;
  while(!predicate()){
    if(Date.now()>until)throw new Error('Timed out waiting for '+description);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

test('GitHub write repositories are operator-only, exact and bounded',()=>{
  assert.deepEqual(githubWriteRepositories(undefined),[]);
  assert.deepEqual(githubWriteRepositories('affank1020/Relay,Demo/repo'),['affank1020/relay','demo/repo']);
  for(const raw of ['owner/*','owner/repo,owner/REPO','../repo','a/repo,a/repo',
    'https://example.com/repo','owner/repo/path','owner/.','a/repo,',Array.from({length:9},(_,i)=>'owner/repo'+i).join(',')])
    assert.throws(()=>githubWriteRepositories(raw),/Invalid|Duplicate/);
  assert.deepEqual(approvedGitHubWriteArgs('add_issue_comment',argumentsForComment,['affank1020/relay']),
    argumentsForComment);
  for(const invalid of [
    {...argumentsForComment,repo:'atlas'}, {...argumentsForComment,issue_number:0},
    {...argumentsForComment,issue_number:'28'}, {...argumentsForComment,body:''},
    {...argumentsForComment,body:'x'.repeat(8001)}, {...argumentsForComment,command:'push'},
    {...argumentsForComment,body:'bad\u0000body'}
  ])assert.equal(approvedGitHubWriteArgs('add_issue_comment',invalid,['affank1020/relay']),null);
  assert.equal(approvedGitHubWriteArgs('push_files',argumentsForComment,['affank1020/relay']),null);
  assert.deepEqual(approvedGitHubWriteArgs('create_issue',
    {owner:'affank1020',repo:'relay',title:'Found a regression'},['affank1020/relay']),
    {owner:'affank1020',repo:'relay',title:'Found a regression'});
});

test('writes are absent without operator allowlist/approval and never reach child agents',async()=>{
  const store=new Store(':memory:');
  const task=taskFixture(store);
  let calls=0;
  const transport:ProviderTransport={list:async()=>both,call:async()=>{calls++;return {ok:true};},close:async()=>{}};
  const readOnly=configuredProviders({RELAY_GITHUB_TOKEN:'secret'})[0];
  const scoped=configuredProviders({RELAY_GITHUB_TOKEN:'secret',RELAY_GITHUB_WRITE_REPOS:'affank1020/relay'})[0];
  const ro=new ConnectionManager([readOnly],()=>true,()=>transport);
  const manager=new ConnectionManager([scoped],()=>true,()=>transport);
  try {
    const noScope=await comment(ro,task,store,new AbortController().signal,async()=>{});
    assert.deepEqual(noScope.map(t=>t.name),['mcp_github_issue_read']);
    const noApproval=await comment(manager,task,store,new AbortController().signal);
    assert.deepEqual(noApproval.map(t=>t.name),['mcp_github_issue_read']);
    const child=await comment(manager,{...task,parentId:randomUUID()},store,new AbortController().signal,async()=>{});
    // Child agents never even see the mutation tool. A retained wrapper is
    // still denied independently at invocation.
    assert.deepEqual(child.map(t=>t.name),['mcp_github_issue_read']);
    assert.equal(calls,0);
    assert.deepEqual(manager.list()[0].availableWriteTools,['add_issue_comment','create_issue']);
  }finally{await manager.close();await ro.close();store.close();}
});

test('write approval holds transport, confirms exact arguments, and never persists raw results in generic activity',async()=>{
  const store=new Store(':memory:');
  const task=taskFixture(store);
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'do-not-expose',RELAY_GITHUB_WRITE_REPOS:'affank1020/relay'})[0];
  let sent:Record<string,unknown>|undefined,calls=0,approveStarted!:()=>void,finishApproval!:()=>void;
  const entered=new Promise<void>(resolve=>{approveStarted=resolve;});
  const release=new Promise<void>(resolve=>{finishApproval=resolve;});
  const manager=new ConnectionManager([provider],()=>true,()=>({
    list:async()=>both,
    call:async(name,args)=>{calls++;assert.equal(name,'add_issue_comment');sent=args;return {
      content:[{type:'text',text:'very-sensitive-remote-result'}]};},
    close:async()=>{}
  }));
  try{
    const tools=await comment(manager,task,store,new AbortController().signal,async(_,invId,tool,args)=>{
      assert.equal(tool,'github:add_issue_comment');
      assert.ok(invId);
      assert.deepEqual(args,argumentsForComment);
      approveStarted();await release;
    });
    const write=tools.find(t=>t.name==='mcp_github_add_issue_comment');assert.ok(write);
    const pending=write.execute('approved-call',argumentsForComment,new AbortController().signal,undefined,{} as never);
    await entered;
    assert.equal(calls,0,'the remote MCP call must not dispatch before approval');
    assert.equal(store.invocationStates(task.id)[0],'validating');
    finishApproval();
    const result=await pending;
    assert.equal(calls,1);
    assert.deepEqual(sent,argumentsForComment);
    assert.match(JSON.stringify(result),/very-sensitive-remote-result/);
    assert.deepEqual(store.invocationStates(task.id),['completed']);
    assert.deepEqual(store.events(task.conversationId).filter(e=>e.type==='tool').map(e=>e.state),
      ['validating','started','completed']);
    const receipts=JSON.stringify(store.events(task.conversationId));
    assert.doesNotMatch(receipts,/do-not-expose|very-sensitive-remote-result|Explicitly approved discussion/);
    assert.equal(store.events(task.conversationId).at(-1)?.agentRunId,task.agentRunId);
    await assert.rejects(write.execute('approved-call',argumentsForComment,
      new AbortController().signal,undefined,{} as never),/already recorded/);
    assert.equal(calls,1,'same Pi call ID is never replayed');
  }finally{await manager.close();store.close();}
});

test('approval rejection and scope disable cannot dispatch a GitHub write',async()=>{
  const store=new Store(':memory:');
  const task=taskFixture(store);
  let enabled=true,calls=0;
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'secret',RELAY_GITHUB_WRITE_REPOS:'affank1020/relay'})[0];
  const manager=new ConnectionManager([provider],()=>enabled,()=>({
    list:async()=>both,call:async()=>{calls++;return {};},close:async()=>{}
  }));
  try{
    const writes=await comment(manager,task,store,new AbortController().signal,async()=>{throw Error('rejected');});
    const write=writes.find(t=>t.name==='mcp_github_add_issue_comment')!;
    await assert.rejects(write.execute('rejected',argumentsForComment,new AbortController().signal,undefined,{} as never),/not approved/);
    assert.deepEqual(store.invocationStates(task.id),['denied_before_dispatch']);
    const another=await comment(manager,task,store,new AbortController().signal,async()=>{enabled=false;});
    await assert.rejects(another.find(t=>t.name==='mcp_github_add_issue_comment')!
      .execute('revoked',argumentsForComment,new AbortController().signal,undefined,{} as never),/not approved/);
    assert.equal(calls,0);
    assert.deepEqual(store.invocationStates(task.id).sort(),['denied_before_dispatch','denied_before_dispatch']);
  }finally{await manager.close();store.close();}
});

test('a timed-out or error-responding write is uncertain, never replayed or silently deletable',async()=>{
  const store=new Store(':memory:');const task=taskFixture(store);
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'secret',RELAY_GITHUB_WRITE_REPOS:'affank1020/relay'})[0];
  let calls=0;
  const manager=new ConnectionManager([provider],()=>true,()=>({
    list:async()=>both,call:async()=>{calls++;throw Error('network interrupted after dispatch');},
    close:async()=>{}
  }));
  try{
    const write=(await comment(manager,task,store,new AbortController().signal,async()=>{}))
      .find(t=>t.name==='mcp_github_add_issue_comment')!;
    await assert.rejects(write.execute('maybe-posted',argumentsForComment,new AbortController().signal,undefined,{} as never),/uncertain/);
    assert.deepEqual(store.invocationStates(task.id),['uncertain']);
    await assert.rejects(write.execute('maybe-posted',argumentsForComment,new AbortController().signal,undefined,{} as never),/already recorded/);
    assert.equal(calls,1);
  }finally{await manager.close();store.close();}
});

test('a full Relay task requires authenticated approval and confirmed writes are deletable',{timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-write-engine-'));
  const store=new Store(':memory:');
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'private-token',RELAY_GITHUB_WRITE_REPOS:'affank1020/relay'})[0];
  let calls=0;
  const registry=new CapabilityRegistry(root,join(process.cwd(),'skills'),[provider],()=>({
    list:async()=>both,
    call:async()=>{calls++;return {content:[{type:'text',text:'posted'}]};},
    close:async()=>{}
  }));
  await registry.update('integrations','github',true);
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},
    deleteConversationSessions:async()=>{},
    run:async(request:HarnessRequest)=>{
      const write=request.tools.find(tool=>tool.name==='mcp_github_add_issue_comment');
      assert.ok(write,'root inference receives admitted GitHub write tool');
      await write.execute('full-task-call',argumentsForComment,request.signal,undefined,{} as never);
      return 'posted';
    }
  };
  const engine=new Engine(store,harness,{concurrency:1,queue:10,sessionUsd:0,globalUsd:0,
    sessionTokens:0,reserveUsd:0,maxRunMs:10000},undefined,{},undefined,registry);
  const token='x'.repeat(32);
  const server=createPlatform(engine,token,join(process.cwd(),'public'),'cohere/north-mini-code:free',undefined,registry);
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const addr=server.address();assert.ok(addr&&typeof addr==='object');
    const url='http://127.0.0.1:'+addr.port;
    const chat=engine.conversation();
    const job=engine.enqueue(chat.id,'Comment on issue 28','full-write');
    await waitFor(()=>!!store.all<Approval>('approvals').find(a=>a.taskId===job.id&&a.state==='pending'),'write approval');
    assert.equal(calls,0);
    const pending=store.all<Approval>('approvals').find(a=>a.taskId===job.id)!;
    assert.equal(pending.tool,'github:add_issue_comment');
    assert.deepEqual(pending.args,argumentsForComment);
    assert.equal((await fetch(url+'/api/approvals/'+pending.id,{method:'POST',body:'{"approved":true}'})).status,401);
    assert.equal(calls,0);
    const resp=await fetch(url+'/api/approvals/'+pending.id,{method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"approved":true}'});
    assert.equal(resp.status,200);
    await waitFor(()=>engine.tasks().find(t=>t.id===job.id)?.state==='completed','task completion');
    assert.equal(calls,1);
    assert.equal(store.all<Approval>('approvals').find(a=>a.id===pending.id)?.state,'approved');
    assert.equal(store.invocationStates(job.id)[0],'completed');
    await engine.deleteConversation(chat.id);
    assert.equal(store.get('conversations',chat.id),undefined);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});
  }
});
