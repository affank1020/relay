import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Store,type Task} from '../src/store.js';
import {configuredProviders} from '../src/integrations/manager.js';
import {nativeMcpAllowed,nativeMcpAuditExtension,type NativeMcpRun} from '../src/pi-native-mcp.js';

test('Atlas coding is disabled by default and never granted to subagents',()=>{
  const atlas=configuredProviders({ATLAS_MCP_URL:'https://atlas.example/mcp',
    ATLAS_MCP_TOKEN:'credential',RELAY_ATLAS_CODING_CHECKOUTS:randomUUID()})[1];
  const store=new Store(':memory:');
  const id=randomUUID(),conversationId=randomUUID();
  const root:Task={id,conversationId,requestId:randomUUID(),prompt:'Fix issue',state:'running',
    createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,
    result:'',error:null,usage:[],agentRunId:randomUUID()};
  const run:NativeMcpRun={task:root,store,providers:[{config:atlas,enabled:()=>true}],
    approve:async()=>{},signal:new AbortController().signal,
    atlasCodingInspect:async()=>{throw Error('unreachable');}};
  try{
    assert.ok(nativeMcpAllowed(run).includes('mcp__atlas__workspace_patch_file'));
    assert.ok(!nativeMcpAllowed({...run,task:{...root,parentId:randomUUID()}}).includes('mcp__atlas__workspace_patch_file'));
    assert.ok(!nativeMcpAllowed({...run,atlasCodingInspect:undefined}).includes('mcp__atlas__workspace_patch_file'));
    assert.ok(!nativeMcpAllowed({...run,approve:undefined}).includes('mcp__atlas__workspace_patch_file'));
    const empty=configuredProviders({ATLAS_MCP_URL:'https://atlas.example/mcp',ATLAS_MCP_TOKEN:'credential'})[1];
    assert.ok(!nativeMcpAllowed({...run,providers:[{config:empty,enabled:()=>true}]}).includes('mcp__atlas__workspace_patch_file'));
  }finally{store.close();}
});

test('approved base can create isolated worktree, then bounded edits require a single scope approval',async()=>{
  const store=new Store(':memory:'),base=randomUUID(),child=randomUUID(),node=randomUUID();
  const conversationId=randomUUID();
  const task:Task={id:randomUUID(),conversationId,requestId:randomUUID(),prompt:'Fix issue',state:'running',
    createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,
    result:'',error:null,usage:[],agentRunId:randomUUID()};
  store.save('tasks',task);
  let enabled=true,approvals:string[]=[];
  const atlas=configuredProviders({ATLAS_MCP_URL:'https://atlas.example/mcp',ATLAS_MCP_TOKEN:'credential',
    RELAY_ATLAS_CODING_CHECKOUTS:base})[1];
  const run:NativeMcpRun={task,store,providers:[{config:atlas,enabled:()=>enabled}],
    approve:async(_task,_id,tool)=>{approvals.push(tool);},
    signal:new AbortController().signal,devTasks:{[child]:['test']},
    atlasCodingInspect:async id=>({id,nodeId:node,repository:'affank1020/relay',
      branch:id===base?'main':'atlas/coding-issue',active:true,online:true,
      capabilities:['workspace.files','workspace.git','workspace.dev']})};
  const hooks=new Map<string,(event:any)=>Promise<any>>();
  nativeMcpAuditExtension(run).factory({on:(name:string,fn:any)=>{hooks.set(name,fn);return ()=>{};}} as never);
  const call=(tool:string,id:string,input:Record<string,unknown>)=>hooks.get('tool_call')!({
    toolName:'mcp__atlas__'+tool,toolCallId:id,input});
  const result=(tool:string,id:string,structuredContent:any={})=>hooks.get('tool_result')!({
    toolName:'mcp__atlas__'+tool,toolCallId:id,isError:false,
    input:{},content:[],structuredContent:{structuredContent}});
  try{
    assert.match(JSON.stringify(await call('workspace_patch_file','base-edit',
      {checkoutId:base,path:'src/a.ts',expectedSha256:'x',oldText:'a',newText:'b'})),/Checkout branch/);
    assert.equal(approvals.length,0);
    assert.equal(await call('workspace_git_create_worktree','create',
      {checkoutId:base,branch:'atlas/coding-issue',targetPath:'/tmp/coding-issue'}),undefined);
    assert.deepEqual(approvals,['atlas:workspace_git_create_worktree']);
    await result('workspace_git_create_worktree','create',{result:{id:child}});
    assert.equal(await call('workspace_patch_file','edit-1',
      {checkoutId:child,path:'src/a.ts',expectedSha256:'sha1',oldText:'a',newText:'b'}),undefined);
    await result('workspace_patch_file','edit-1');
    assert.equal(await call('workspace_patch_file','edit-2',
      {checkoutId:child,path:'src/b.ts',expectedSha256:'sha2',oldText:'a',newText:'b'}),undefined);
    await result('workspace_patch_file','edit-2');
    assert.deepEqual(approvals,['atlas:workspace_git_create_worktree','atlas:coding_checkout']);
    assert.equal(await call('workspace_run_dev_task','test',{checkoutId:child,task:'test'}),undefined);
    await result('workspace_run_dev_task','test');
    assert.equal(await call('workspace_git_open_pull_request','pr',
      {checkoutId:child,repository:'affank1020/relay',branch:'atlas/coding-issue',
        expectedHead:'a'.repeat(40),title:'Test coding PR'}),undefined);
    await result('workspace_git_open_pull_request','pr');
    assert.equal(approvals.at(-1),'atlas:workspace_git_open_pull_request');
    assert.equal((store.get('invocations',task.id+':edit-1') as any).state,'completed');
    assert.equal((store.get('invocations',task.id+':create') as any).kind,'mcp_write');
    enabled=false;
    assert.match(JSON.stringify(await call('workspace_patch_file','revoked',{checkoutId:child})),/not permitted/);
  }finally{store.close();}
});

test('Atlas publishing checks the verified remote and rejects unauthorized named commands',async()=>{
  const store=new Store(':memory:');const base=randomUUID(),node=randomUUID();
  const task:Task={id:randomUUID(),conversationId:randomUUID(),requestId:randomUUID(),
    prompt:'Fix',state:'running',createdAt:new Date().toISOString(),parentId:null,
    dependencies:[],attemptOf:null,result:'',error:null,usage:[],agentRunId:randomUUID()};
  store.save('tasks',task);
  const atlas=configuredProviders({ATLAS_MCP_URL:'https://atlas.example/mcp',ATLAS_MCP_TOKEN:'credential',
    RELAY_ATLAS_CODING_CHECKOUTS:base})[1];
  let approvals=0;
  const run:NativeMcpRun={task,store,providers:[{config:atlas,enabled:()=>true}],
    approve:async()=>{approvals++;},signal:new AbortController().signal,devTasks:{[base]:['test']},
    atlasCodingInspect:async id=>({id,nodeId:node,repository:'owner/relay',branch:'atlas/fix',
      active:true,online:true,capabilities:['workspace.git','workspace.files','workspace.dev']})};
  const hooks=new Map<string,(event:any)=>Promise<any>>();
  nativeMcpAuditExtension(run).factory({on:(name:string,fn:any)=>{hooks.set(name,fn);return ()=>{};}} as never);
  const check=async (tool:string,input:Record<string,unknown>)=>hooks.get('tool_call')!({
    toolName:'mcp__atlas__'+tool,toolCallId:randomUUID(),input});
  try{
    assert.match(JSON.stringify(await check('workspace_run_dev_task',{checkoutId:base,task:'deploy'})),/allowlist/);
    assert.match(JSON.stringify(await check('workspace_git_open_pull_request',
      {checkoutId:base,repository:'other/repo',branch:'atlas/fix'})),/differs/);
    assert.equal(approvals,0);
  }finally{store.close();}
});
