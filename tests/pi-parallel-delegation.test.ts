import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piSubagentRuntime } from '../src/pi-subagents-runtime.js';
import type { SubagentsBus } from '../src/pi-subagents-rpc.js';

class FakeBus implements SubagentsBus {
  handlers=new Map<string,Set<(value:unknown)=>void>>();
  on(event:string,listener:(value:unknown)=>void):()=>void {
    const set=this.handlers.get(event)??new Set<(value:unknown)=>void>();
    set.add(listener);this.handlers.set(event,set);
    return ()=>{set.delete(listener);if(!set.size)this.handlers.delete(event);};
  }
  emit(event:string,value:unknown):void {
    for(const listener of [...(this.handlers.get(event)??[])])listener(value);
  }
}
const read='mcp__github__issue_read';
test('batch starts two independent Pi researchers concurrently and requires real reads',async()=>{
  const prior=process.env.RELAY_PI_CHILD_MCP;
  process.env.RELAY_PI_CHILD_MCP='1';
  const key=Symbol.for('pi-subagents:manager');
  const slots=globalThis as unknown as Record<symbol,unknown>;
  const previous=slots[key];
  const sessions=new Map<string,string>();
  slots[key]={getRecord:(id:string)=>{
    const sid=sessions.get(id);
    return sid?{session:{sessionManager:{getSessionId:()=>sid}}}:undefined;
  }};
  const bus=new FakeBus(),spawns:string[]=[],finished:string[]=[],receipts:string[]=[];
  const tracked:string[]=[];
  const controller=new AbortController();
  bus.on('subagents:rpc:ping',raw=>{
    const req=raw as {requestId:string};
    bus.emit('subagents:rpc:ping:reply:'+req.requestId,
      {success:true,data:{version:2}});
  });
  bus.on('subagents:rpc:spawn',raw=>{
    const req=raw as {requestId:string;type:string;prompt:string};
    assert.equal(req.type,'relay-research');
    const issue=/28/.test(req.prompt)?'28':'29';
    const id='pi-'+issue;
    spawns.push(id);
    sessions.set(id,'session-'+issue);
    bus.emit('subagents:rpc:spawn:reply:'+req.requestId,
      {success:true,data:{id}});
    queueMicrotask(()=>bus.emit('subagents:started',{id}));
    // Wait for both concurrent spawn requests before completing either.
    const emitRead=()=>{
      if(spawns.length<2){setTimeout(emitRead,5);return;}
      const requestId='read-'+issue;
      const off=bus.on('relay:child-mcp:reply:'+requestId,value=>{
        off();
        const result=value as {success:boolean;text:string};
        if(!result.success){
          bus.emit('subagents:failed',{id,error:result.text});return;
        }
        finished.push(id);
        bus.emit('subagents:completed',{id,
          result:'Issue #'+issue+' verified body: '+result.text});
      });
      bus.emit('relay:child-mcp:read',{requestId,sessionId:'session-'+issue,
        tool:read,args:{method:'get',owner:'affank1020',repo:'relay',
          issue_number:Number(issue)}});
    };
    setTimeout(emitRead,20);
  });
  try {
    const runtime=piSubagentRuntime(controller.signal,event=>
      tracked.push(event.status+':'+event.agentId),[read],
      (id,tool,success)=>{if(success)receipts.push(id+':'+tool);});
    runtime.extensionFactory({events:bus});
    const response=await runtime.batchTool.execute('batch-1',{tasks:[
      {prompt:'Read GitHub issue #28',tools:[read]},
      {prompt:'Read GitHub issue #29',tools:[read]}
    ]},controller.signal,undefined,{
      executeTool:async(name:string,args:unknown)=>{
        assert.equal(name,read);
        // Real Pi ctx.executeTool returns an AgentToolCallOutcome, with
        // content inside .result rather than at the top level.
        return {toolCall:{id:'nested-'+String((args as {issue_number:number}).issue_number),
          name,arguments:args},isError:false,
          result:{content:[{type:'text',text:'Verified source '+JSON.stringify(args)}]}};
      }
    } as never);
    const summary=JSON.parse(response.content.filter(x=>x.type==='text')
      .map(x=>x.text).join('')) as {requested:number;verifiedChildren:number;children:Array<{agentId:string}>};
    assert.equal(summary.requested,2);
    assert.equal(summary.verifiedChildren,2);
    assert.deepEqual(new Set(summary.children.map(x=>x.agentId)),new Set(['pi-28','pi-29']));
    assert.deepEqual(new Set(spawns),new Set(['pi-28','pi-29']));
    assert.deepEqual(new Set(finished),new Set(['pi-28','pi-29']));
    assert.deepEqual(new Set(receipts),new Set([
      'pi-28:'+read,'pi-29:'+read]));
    assert.equal(tracked.filter(x=>x.startsWith('completed:')).length,2);
  }finally{
    if(previous===undefined)delete slots[key];else slots[key]=previous;
    if(prior===undefined)delete process.env.RELAY_PI_CHILD_MCP;
    else process.env.RELAY_PI_CHILD_MCP=prior;
  }
});

test('batch validates every research child before any spawn',async()=>{
  const prior=process.env.RELAY_PI_CHILD_MCP;
  process.env.RELAY_PI_CHILD_MCP='1';
  const controller=new AbortController(),bus=new FakeBus();
  let spawns=0;
  bus.on('subagents:rpc:spawn',()=>{spawns++;});
  const runtime=piSubagentRuntime(controller.signal,undefined,[read]);
  runtime.extensionFactory({events:bus});
  await assert.rejects(runtime.batchTool.execute('reject-all',{tasks:[
    {prompt:'Read GitHub issue #28',tools:[read]},
    {prompt:'Read GitHub issue #29',tools:[]}
  ]},controller.signal,undefined,{} as never),/require explicit read tools/);
  assert.equal(spawns,0);
  if(prior===undefined)delete process.env.RELAY_PI_CHILD_MCP;
  else process.env.RELAY_PI_CHILD_MCP=prior;
});
