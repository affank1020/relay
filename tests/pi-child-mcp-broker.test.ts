import assert from 'node:assert/strict';
import { sharedPiChildMcpBus } from '../src/pi-child-mcp-bus.js';
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
  assert.equal(broker.bind('unsafe-github',['mcp__github__create_issue'],
    registry('unsafe-github','session-write')),false);
  const results:unknown[]=[];
  const listen=(id:string)=>bus.on('relay:child-mcp:reply:'+id,r=>results.push(r));
  const unsubs=[listen('deny1'),listen('deny2')];
  bus.emit('relay:child-mcp:read',{requestId:'deny1',sessionId:'session1',
    tool:'mcp__github__create_issue',args:{title:'bad'}});
  bus.emit('relay:child-mcp:read',{requestId:'deny2',sessionId:'unbound',
    tool:'mcp__github__issue_read',args:{}});
  await settle();
  assert.equal(calls,0);
  // A broker must reject forbidden tools on an owned session, but it must
  // stay silent about unrelated/unbound sessions (another Pi broker may own
  // them). The child-side tool itself fails closed on timeout if no one owns it.
  assert.equal(results.length,1);
  assert.equal((results[0] as {success:boolean}).success,false);
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
  const bus=sharedPiChildMcpBus();let tool:Record<string,unknown>|undefined;
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

test('two simultaneous Pi child brokers never send competing success/denial replies',async()=>{
  const bus=new Bus(),controller=new AbortController(),replies=new Map<string,unknown[]>();
  const first=new PiChildMcpBroker(bus,controller.signal,async()=>({
    content:[{type:'text',text:'verified issue 28'}]
  }));
  const second=new PiChildMcpBroker(bus,controller.signal,async()=>({
    content:[{type:'text',text:'verified issue 29'}]
  }));
  try{
    assert.equal(first.bind('child-28',['mcp__github__issue_read'],
      registry('child-28','sid-28')),true);
    assert.equal(second.bind('child-29',['mcp__github__issue_read'],
      registry('child-29','sid-29')),true);
    const unsubs=['read-28','read-29'].map(id=>bus.on(
      'relay:child-mcp:reply:'+id,reply=>{
        const arr=replies.get(id)??[];arr.push(reply);replies.set(id,arr);
      }));
    bus.emit('relay:child-mcp:read',{requestId:'read-28',
      sessionId:'sid-28',tool:'mcp__github__issue_read',args:{issue_number:28}});
    bus.emit('relay:child-mcp:read',{requestId:'read-29',
      sessionId:'sid-29',tool:'mcp__github__issue_read',args:{issue_number:29}});
    await settle();
    assert.deepEqual(replies.get('read-28'),[{success:true,text:'verified issue 28'}]);
    assert.deepEqual(replies.get('read-29'),[{success:true,text:'verified issue 29'}]);
    assert.equal(first.verifiedReadCount,1);
    assert.equal(second.verifiedReadCount,1);
    for(const remove of unsubs)remove();
  }finally{first.close();second.close();}
});

test('Pi child MCP broker does not count a successful tool outcome with missing source content',async()=>{
  const bus=new Bus(),controller=new AbortController(),receipts:boolean[]=[];
  const broker=new PiChildMcpBroker(bus,controller.signal,async()=>({isError:false,content:[]}),
    (_agent,_tool,success)=>receipts.push(success));
  const unlisten=bus.on('relay:child-mcp:reply:empty',result=>{
    response=result as {success:boolean;text:string};
  });
  let response:{success:boolean;text:string}|undefined;
  try{
    assert.equal(broker.bind('source-child',['mcp__github__issue_read'],
      registry('source-child','source-session')),true);
    bus.emit('relay:child-mcp:read',{requestId:'empty',sessionId:'source-session',
      tool:'mcp__github__issue_read',args:{method:'get',issue_number:29}});
    await settle();
    assert.equal(response?.success,false);
    assert.match(response?.text??'',/no source content/);
    assert.deepEqual(receipts,[false]);
    assert.equal(broker.verifiedReadCount,0);
  }finally{unlisten();broker.close();}
});

test('Delayed local Pi child model startup cannot expire a future authorised read',async()=>{
  const bus=new Bus(),controller=new AbortController(),receipts:boolean[]=[];
  let liveSession:string|undefined;
  const registry:ChildRegistry={getRecord:id=>id==='late-qwen-child'&&liveSession
    ?{session:{sessionManager:{getSessionId:()=>liveSession!}}}:undefined};
  const broker=new PiChildMcpBroker(bus,controller.signal,async(name,args)=>{
    assert.equal(name,'mcp__github__issue_read');
    assert.deepEqual(args,{issue_number:29});
    return {isError:false,content:[{type:'text',text:'Actual issue 29 body'}]};
  },(_agent,_tool,success)=>receipts.push(success));
  try{
    assert.equal(broker.allowPendingAgent('late-qwen-child',
      ['mcp__github__issue_read'],registry),true);
    // Registration must not use a guessed session ID, and a fake session has
    // no grant even after an agent ID is recognised.
    let unexpected=0;
    const off=bus.on('relay:child-mcp:reply:fake',()=>unexpected++);
    bus.emit('relay:child-mcp:read',{requestId:'fake',sessionId:'untrusted',
      tool:'mcp__github__issue_read',args:{issue_number:29}});
    await settle();assert.equal(unexpected,0);off();
    // Simulate Pi assigning a real SDK session after delayed Ollama startup.
    liveSession='real-qwen-session';
    let response:unknown;
    const remove=bus.on('relay:child-mcp:reply:real',r=>{response=r;});
    bus.emit('relay:child-mcp:read',{requestId:'real',
      sessionId:'real-qwen-session',tool:'mcp__github__issue_read',
      args:{issue_number:29}});
    await settle();
    assert.deepEqual(response,{success:true,text:'Actual issue 29 body'});
    assert.equal(broker.verifiedReadCount,1);
    assert.deepEqual(receipts,[true]);
    remove();
    broker.revoke('late-qwen-child');
    assert.equal(broker.verifiedReadCount,1);
  }finally{broker.close();}
});

test('A revoked pending child grant cannot become active on its eventual SDK session',async()=>{
  const bus=new Bus(),controller=new AbortController();let called=0;
  let live:string|undefined;
  const registry:ChildRegistry={getRecord:id=>id==='agent-1'&&live
    ?{session:{sessionManager:{getSessionId:()=>live!}}}:undefined};
  const broker=new PiChildMcpBroker(bus,controller.signal,async()=>{called++;return {
    content:[{type:'text',text:'data'}]
  };});
  try{
    assert.equal(broker.allowPendingAgent('agent-1',['mcp__github__issue_read'],registry),true);
    broker.revoke('agent-1');
    live='session-after-revocation';
    bus.emit('relay:child-mcp:read',{requestId:'revoked',
      sessionId:live,tool:'mcp__github__issue_read',args:{issue_number:29}});
    await settle();
    assert.equal(called,0);
    assert.equal(broker.verifiedReadCount,0);
  }finally{broker.close();}
});
