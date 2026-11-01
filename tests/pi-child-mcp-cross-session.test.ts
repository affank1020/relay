import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedPiChildMcpBus } from '../src/pi-child-mcp-bus.js';
import { PiChildMcpBroker,type ChildRegistry } from '../src/pi-child-mcp-broker.js';
import relayChildMcp from '../src/pi-child-mcp-extension.js';

// This intentionally models TWO INDEPENDENT Pi DefaultResourceLoader buses:
// parent Pi SDK events and child Pi SDK events never exchange events.
// In production the child extension is also compiled to a separate ESM entry.
test('independent Pi sessions can complete verified GitHub read through shared bridge',async()=>{
  const parentPiBus={on:()=>()=>{},emit:()=>{throw Error('root Pi bus should not carry child reads');}};
  const childPiBus={on:()=>()=>{},emit:()=>{throw Error('child Pi bus should not carry parent reads');}};
  const bridge=sharedPiChildMcpBus();
  const agentId='real-child-agent',sessionId='real-child-session';
  const registry:ChildRegistry={getRecord:id=>id===agentId
    ?{session:{sessionManager:{getSessionId:()=>sessionId}}}:undefined};
  const observed:Array<{name:string;args:unknown}>=[];
  const broker=new PiChildMcpBroker(bridge,new AbortController().signal,async(name,args)=>{
    observed.push({name,args});
    return {isError:false,content:[{type:'text',text:'Issue #29: verified from actual nested tool result'}]};
  });
  assert.equal(broker.allowPendingAgent(agentId,['mcp__github__issue_read'],registry),true);
  let readTool:Record<string,unknown>|undefined;
  relayChildMcp({events:childPiBus,registerTool:(tool:Record<string,unknown>)=>{
    readTool=tool;
  }} as never);
  try{
    assert.ok(readTool);
    const exec=readTool.execute as (...args:unknown[])=>Promise<{
      content:Array<{type:string;text:string}>;details:{verified:boolean}
    }>;
    const response=await exec('test-call',{tool:'mcp__github__issue_read',
      args:{owner:'affank1020',repo:'relay',issue_number:29,method:'get'}},
      new AbortController().signal,undefined,
      {sessionManager:{getSessionId:()=>sessionId}});
    assert.equal(response.details.verified,true);
    assert.match(response.content[0].text,/Issue #29/);
    assert.equal(observed.length,1);
    assert.deepEqual(observed[0].args,{owner:'affank1020',repo:'relay',issue_number:29,method:'get'});
    assert.equal(broker.verifiedReadCount,1);
    void parentPiBus; // It deliberately does not participate in the bridge.
  }finally{broker.close();}
});

test('shared bridge never grants an unregistered child a GitHub read',async()=>{
  let calls=0;
  const bridge=sharedPiChildMcpBus();
  const broker=new PiChildMcpBroker(bridge,new AbortController().signal,async()=>{
    calls++;return {content:[{type:'text',text:'would be a leak'}]};
  });
  let leaked=0;
  const off=bridge.on('relay:child-mcp:reply:forged',()=>{leaked++;});
  try{
    bridge.emit('relay:child-mcp:read',{requestId:'forged',sessionId:'unknown',
      tool:'mcp__github__issue_read',args:{issue_number:29}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(leaked,0);
    assert.equal(calls,0);
  }finally{off();broker.close();}
});
