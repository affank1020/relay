import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createPlatform } from '../src/platform.js';

test('authenticated model switching keeps the conversation and rejects changes during execution',async()=>{
  const store=new Store(':memory:');
  let release:()=>void=()=>{};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const registry={defaultKey:'openrouter/a:free',models:['a:free','b:free'].map(id=>({id,key:'openrouter/'+id,provider:'openrouter' as const,label:id}))};
  const seen:string[]=[];
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},run:async request=>{seen.push(request.modelKey!);await hold;return 'done';}},
    {concurrency:1,queue:4,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000},undefined,{},registry);
  const server=createPlatform(engine,'a'.repeat(32),'/tmp','a:free',registry);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const chat=engine.conversation();
  const headers={Authorization:'Bearer '+'a'.repeat(32),'Content-Type':'application/json'};
  try{
    const path=url+'/api/sessions/'+chat.id;
    assert.equal((await fetch(path,{method:'PATCH',body:JSON.stringify({modelKey:'openrouter/b:free'})})).status,401);
    assert.equal((await fetch(path+'/transcript')).status,401);
    assert.equal((await fetch(path,{method:'PATCH',headers,body:JSON.stringify({modelKey:'openrouter/b:free'})})).status,200);
    assert.equal(engine.store.get<{id:string;modelKey:string}>('conversations',chat.id)?.modelKey,'openrouter/b:free');
    engine.enqueue(chat.id,'hello','model-switch-request');
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal((await fetch(path,{method:'PATCH',headers,body:JSON.stringify({modelKey:'openrouter/a:free'})})).status,409);
    assert.deepEqual(seen,['openrouter/b:free']);
    assert.equal(engine.store.all('conversations').length,1);
  }finally{release();await engine.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
