import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiChildMcpBroker,type ChildRegistry } from '../src/pi-child-mcp-broker.js';
import type { SubagentsBus } from '../src/pi-subagents-rpc.js';
import childExtension from '../src/pi-child-mcp-extension.js';

class Bus implements SubagentsBus {
  handlers=new Map<string,Set<(x:unknown)=>void>>();
  on(event:string,listener:(x:unknown)=>void):()=>void {
    const set=this.handlers.get(event)??new Set();
    set.add(listener);this.handlers.set(event,set);
    return ()=>{set.delete(listener);if(!set.size)this.handlers.delete(event);};
  }
  emit(event:string,data:unknown):void {
    for(const fn of this.handlers.get(event)??[])fn(data);
  }
}
const registry=(agentId:string,sessionId:string):ChildRegistry=>({
  getRecord:id=>id===agentId?{session:{sessionManager:{getSessionId:()=>sessionId}}}:undefined
});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('Pi child MCP broker accepts exactly one admitted read from its real session ID',async()=>{
  const bus=new Bus(),controller=new AbortController(),effects:string[]=[];
  const broker=new PiChildMcpBroker(bus,controller.signal,async(name,args)=>{
    effects.push(name+':'+JSON.stringify(args));
    return {content:[{type:'text',text:'Issue #29: verified title and requirements'}]};
  });
  const reg=registry('agent1','session1');
  assert.equal(broker.bind('agent1',['mcp__github__issue_read'],reg),true);
  let received:unknown;
  const off=bus.on('relay:child-mcp:reply:r1',x=>received=x);
  bus.emit('relay:child-mcp:read',{requestId:'r1',sessionId:'session1',
    tool:'mcp__github__issue_read',args:{method:'get',owner:'affank1020',repo:'relay',issue_number:29}});
  await settle();
  assert.deepEqual(received,{success:true,text:'Issue #29: verified title and requirements'});
  assert.equal(broker.verifiedReadCount,1);
  assert.equal(effects.length,1);
  off();broker.close();
});

test('Unbound or unapproved children cannot invoke native MCP or write tools',async()=>{
  const bus=new Bus(),controller=new AbortController();let calls=0;
  const broker=new PiChildMcpBroker(bus,controller.signal,async()=>{calls++;return {};});
  const reg=registry('agent1','session1');
  broker.bind('agent1',['mcp__github__issue_read'],reg);
  const results:unknown[]=[];
  const listen=(id:string)=>bus.on('relay:child-mcp:reply:'+id,r=>results.push(r));
  const unsubs=[listen('deny1'),listen('deny2')];
  bus.emit('relay:child-mcp:read',{requestId:'deny1',sessionId:'session1',
    tool:'mcp__github__create_issue',args:{title:'bad'}});
  bus.emit('relay:child-mcp:read',{requestId:'deny2',sessionId:'unbound',
    tool:'mcp__github__issue_read',args:{}});
  await settle();
  assert.equal(calls,0);
  assert.equal(results.length,2);
  assert.ok(results.every(r=>(r as {success:boolean}).success===false));
  broker.revoke('agent1');
  const off=listen('deny3');
  bus.emit('relay:child-mcp:read',{requestId:'deny3',sessionId:'session1',
    tool:'mcp__github__issue_read',args:{}});
  await settle();assert.equal(calls,0);assert.equal(broker.verifiedReadCount,0);
  off();for(const fn of unsubs)fn();broker.close();
});

test('Revocation during a pending MCP call rejects results and records no verified read',async()=>{
  const bus=new Bus(),controller=new AbortController();
  let finish!:(value:{content:Array<{type:string;text:string}>})=>void;
  const broker=new PiChildMcpBroker(bus,controller.signal,async()=>
    await new Promise<{content:Array<{type:string;text:string}>}>(resolve=>{finish=resolve;}));
  broker.bind('agent1',['mcp__github__issue_read'],registry('agent1','session1'));
  let result:unknown;
  const off=bus.on('relay:child-mcp:reply:pending',x=>result=x);
  bus.emit('relay:child-mcp:read',{requestId:'pending',sessionId:'session1',
    tool:'mcp__github__issue_read',args:{issue_number:29}});
  broker.revoke('agent1');
  finish({content:[{type:'text',text:'a leaked response'}]});
  await settle();
  assert.equal((result as {success:boolean}).success,false);
  assert.equal(broker.verifiedReadCount,0);
  assert.doesNotMatch(JSON.stringify(result),/leaked response/);
  off();broker.close();
});

test('Pi child extension exposes only a delegated read proxy and never credentials',async()=>{
  const bus=new Bus();let tool:Record<string,unknown>|undefined;
  childExtension({
    registerTool:(x:Record<string,unknown>)=>{tool=x;},
    events:bus
  } as never);
  assert.equal(tool?.name,'relay_child_mcp_read');
  assert.equal(JSON.stringify(tool).includes('RELAY_GITHUB_TOKEN'),false);
  const broker=new PiChildMcpBroker(bus,new AbortController().signal,async()=>({
    content:[{type:'text',text:'Retrieved real source body'}]
  }));
  broker.bind('child-a',['mcp__github__issue_read'],registry('child-a','sid-a'));
  const execute=tool!.execute as (...args:unknown[])=>Promise<{content:Array<{text:string}>}>;
  const response=await execute('c1',{tool:'mcp__github__issue_read',args:{issue_number:28}},
    new AbortController().signal,undefined,{sessionManager:{getSessionId:()=> 'sid-a'}});
  assert.match(response.content[0].text,/Retrieved real source body/);
  assert.equal(broker.verifiedReadCount,1);
  broker.close();
});

test('Pi child can use placement-checked Atlas reads but never approved Atlas mutations',async()=>{
  const bus=new Bus(),ctrl=new AbortController();let calls=0;
  const broker=new PiChildMcpBroker(bus,ctrl.signal,async(name,args)=>{
    calls++;assert.equal(name,'atlas_workspace_read_file');
    assert.equal((args as {checkoutId:string}).checkoutId,'safe-checkout');
    return {content:[{type:'text',text:'verified Atlas data'}]};
  });
  const granted=broker.bind('child-atlas',['atlas_workspace_read_file'],
    registry('child-atlas','session-atlas'));
  assert.equal(granted,true);
  assert.equal(broker.bind('unsafe',['atlas_workspace_run_dev_task'],
    registry('unsafe','other-session')),false);
  let received:unknown;
  const off=bus.on('relay:child-mcp:reply:atlas1',x=>received=x);
  bus.emit('relay:child-mcp:read',{requestId:'atlas1',sessionId:'session-atlas',
    tool:'atlas_workspace_read_file',args:{checkoutId:'safe-checkout',path:'notes.md'}});
  await settle();
  assert.equal(calls,1);
  assert.deepEqual(received,{success:true,text:'verified Atlas data'});
  off();broker.close();
});
