import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiSubagentsRpc, type SubagentsBus } from '../src/pi-subagents-rpc.js';

class FakeBus implements SubagentsBus {
  private handlers=new Map<string,Set<(value:unknown)=>void>>();
  readonly emitted:Array<{name:string;data:unknown}>=[];
  on(name:string,cb:(data:unknown)=>void):()=>void{
    const set=this.handlers.get(name)??new Set<(data:unknown)=>void>();
    set.add(cb);this.handlers.set(name,set);
    return ()=>{set.delete(cb);if(!set.size)this.handlers.delete(name);};
  }
  emit(name:string,data:unknown):void{
    this.emitted.push({name,data});
    for(const cb of this.handlers.get(name)??[])cb(data);
  }
  listenerCount():number{return [...this.handlers.values()].reduce((n,set)=>n+set.size,0);}
}
const setup=()=>{
  const bus=new FakeBus(),api=new PiSubagentsRpc(bus,100);
  const controller=new AbortController();
  return {bus,api,controller};
};
function wire(bus:FakeBus,method:'ping'|'spawn'|'stop',response:(data:Record<string,unknown>)=>unknown){
  return bus.on('subagents:rpc:'+method,data=>{
    const req=data as Record<string,unknown>;
    bus.emit('subagents:rpc:'+method+':reply:'+req.requestId,response(req));
  });
}

test('Pi protocol v2 handshake rejects missing and incompatible extensions',async()=>{
  const {bus,api}=setup();
  assert.equal(await api.available(),false);
  const remove=wire(bus,'ping',()=>({success:true,data:{version:2}}));
  assert.equal(await api.available(),true);
  remove();
  const wrong=wire(bus,'ping',()=>({success:true,data:{version:1}}));
  assert.equal(await api.available(),false);
  wrong();
  assert.equal(bus.listenerCount(),0);
});

test('isolated Pi child completes even if it finishes before spawn reply',async()=>{
  const {bus,api,controller}=setup();
  const log:string[]=[];
  const remove=wire(bus,'spawn',req=>{
    assert.equal(req.type,'relay-isolated');
    assert.equal(req.prompt,'Summarise supplied text');
    assert.deepEqual(req.options,{
      isolated:true,inheritContext:false,isBackground:true,maxTurns:12,
      description:'Relay isolated delegated task'
    });
    // Pi may complete before its asynchronous awaitStartup RPC replies.
    bus.emit('subagents:completed',{id:'child-01',result:'Verified by local analysis'});
    return {success:true,data:{id:'child-01'}};
  });
  const result=await api.run({prompt:'Summarise supplied text',type:'relay-isolated',
    signal:controller.signal,onTransition:e=>log.push(e.status)});
  assert.deepEqual(result,{agentId:'child-01',result:'Verified by local analysis'});
  assert.deepEqual(log,['completed']);
  assert.ok(bus.emitted.some(e=>e.name==='subagents:rpc:consume'));
  assert.equal(bus.listenerCount(),1);remove();assert.equal(bus.listenerCount(),0);
});

test('failed Pi subagent is reported as failure, never synthetic completion',async()=>{
  const {bus,api,controller}=setup();
  const remove=wire(bus,'spawn',()=>({success:true,data:{id:'child-02'}}));
  const running=api.run({prompt:'Investigate code',type:'relay-isolated',
    signal:controller.signal,maxRunMs:1000});
  // The RPC dispatch is synchronous but the await is a microtask.
  await Promise.resolve();
  bus.emit('subagents:started',{id:'child-02'});
  bus.emit('subagents:failed',{id:'child-02',error:'Model failed'});
  await assert.rejects(running,/Model failed/);
  remove();assert.equal(bus.listenerCount(),0);
});

test('cancel stops a spawned Pi child and clears handlers',async()=>{
  const {bus,api,controller}=setup();
  const spawn=wire(bus,'spawn',()=>({success:true,data:{id:'child-03'}}));
  const stop=wire(bus,'stop',req=>({success:true,data:{stopped:req.agentId}}));
  const task=api.run({prompt:'Research task',type:'relay-isolated',signal:controller.signal});
  await Promise.resolve();
  controller.abort();
  await assert.rejects(task,/cancelled/);
  assert.ok(bus.emitted.some(e=>e.name==='subagents:rpc:stop'&&
    (e.data as {agentId:string}).agentId==='child-03'));
  spawn();stop();assert.equal(bus.listenerCount(),0);
});

test('model-facing input cannot choose a privileged agent type or bypass isolation',async()=>{
  const {bus,api,controller}=setup();
  await assert.rejects(api.run({prompt:'Run shell',type:'general-purpose' as 'relay-isolated',
    signal:controller.signal}),/Invalid isolated/);
  await assert.rejects(api.run({prompt:' ',type:'relay-isolated',signal:controller.signal}),/Invalid isolated/);
  await assert.rejects(api.run({prompt:'safe',type:'relay-isolated',
    maxTurns:1000,signal:controller.signal}),/Invalid subagent turns/);
  assert.equal(bus.emitted.length,0);
  assert.equal(bus.listenerCount(),0);
});

test('RPC spawn refusal does not leave a dangling task or listeners',async()=>{
  const {bus,api,controller}=setup();
  const deny=wire(bus,'spawn',()=>({success:false,error:'No active session'}));
  await assert.rejects(api.run({prompt:'Read files',type:'relay-isolated',signal:controller.signal}),
    /No active session/);
  deny();assert.equal(bus.listenerCount(),0);
});

test('abort before spawn acknowledgement stops the late-starting child',async()=>{
  const {bus,api,controller}=setup();
  let reply:((id:string)=>void)|undefined;
  const stopIds:string[]=[];
  const unspawn=bus.on('subagents:rpc:spawn',data=>{
    const request=data as {requestId:string};
    reply=id=>bus.emit('subagents:rpc:spawn:reply:'+request.requestId,
      {success:true,data:{id}});
  });
  const unstop=bus.on('subagents:rpc:stop',data=>{
    const req=data as {requestId:string;agentId:string};
    stopIds.push(req.agentId);
    bus.emit('subagents:rpc:stop:reply:'+req.requestId,{success:true});
  });
  const changes:string[]=[];
  const task=api.run({prompt:'Analyze',type:'relay-isolated',signal:controller.signal,
    onTransition:event=>changes.push(event.status)});
  controller.abort();
  assert.ok(reply);
  reply!('late-child');
  await assert.rejects(task,/cancelled/);
  await Promise.resolve();
  assert.deepEqual(stopIds,['late-child']);
  assert.deepEqual(changes,['stopped']);
  unspawn();unstop();assert.equal(bus.listenerCount(),0);
});
