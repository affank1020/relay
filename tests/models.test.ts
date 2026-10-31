import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadRelayModels,refreshOllamaModels} from '../src/models.js';

test('local model configuration supports private Tailscale and loopback but rejects public endpoints',()=>{
  const cloud=loadRelayModels({});
  assert.equal(cloud.models.length,1);
  assert.equal(cloud.models[0].provider,'openrouter');
  const local=loadRelayModels({RELAY_OLLAMA_URL:'https://mac.example-tailnet.ts.net/v1',RELAY_OLLAMA_MODELS:'qwen3:4b,qwen3:8b'});
  assert.deepEqual(local.models.map(m=>m.key),[cloud.defaultKey,'ollama/qwen3:4b','ollama/qwen3:8b']);
  assert.equal(local.ollama?.baseUrl,'https://mac.example-tailnet.ts.net/v1');
  const alternate=loadRelayModels({RELAY_OLLAMA_URL:'https://mac.example-tailnet.ts.net:10000/v1',RELAY_OLLAMA_MODELS:'qwen3:4b'});
  assert.equal(alternate.ollama?.baseUrl,'https://mac.example-tailnet.ts.net:10000/v1');
  assert.equal(loadRelayModels({RELAY_OLLAMA_URL:'http://127.0.0.1:11434/v1',RELAY_OLLAMA_MODELS:'qwen3:4b'}).models.length,2);
  for(const endpoint of ['https://example.com/v1','http://192.168.1.10:11434/v1','https://mac.ts.net/v1?token=oops','https://mac.ts.net:9999/v1','https://mac.ts.net@attacker.example/v1']){
    assert.throws(()=>loadRelayModels({RELAY_OLLAMA_URL:endpoint,RELAY_OLLAMA_MODELS:'qwen3:4b'}),/Tailscale/);
  }
  assert.throws(()=>loadRelayModels({RELAY_OLLAMA_MODELS:'qwen3:4b'}),/is required/);
  assert.equal(loadRelayModels({RELAY_OLLAMA_URL:'https://mac.ts.net/v1'}).models.length,1);
  assert.throws(()=>loadRelayModels({RELAY_OLLAMA_URL:'https://mac.ts.net/v1',RELAY_OLLAMA_MODELS:'qwen3:4b,qwen3:4b'}),/Invalid Ollama model/);
  assert.throws(()=>loadRelayModels({RELAY_MODEL:'paid-model'}),/explicit :free/);
});

test('Ollama discovery refreshes the catalog and keeps the last known list when offline',async()=>{
  const registry=loadRelayModels({RELAY_OLLAMA_URL:'https://mac.ts.net/v1',RELAY_OLLAMA_MODELS:'qwen3:4b'});
  let calls=0;
  const request=async(url:string|URL|Request)=>{
    calls++;
    assert.equal(url,'https://mac.ts.net/v1/models');
    return new Response(JSON.stringify({data:[{id:'qwen3:4b'},{id:'qwen3-coder:30b'},{id:'qwen3-coder:30b'},{id:'../../invalid?'},{bad:1}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  await refreshOllamaModels(registry,request,1000);
  assert.equal(registry.ollama?.online,true);
  assert.deepEqual(registry.models.map(x=>x.key),['openrouter/cohere/north-mini-code:free','ollama/qwen3:4b','ollama/qwen3-coder:30b']);
  assert.deepEqual(registry.ollama?.modelIds,['qwen3:4b','qwen3-coder:30b']);
  await refreshOllamaModels(registry,request,1001);
  assert.equal(calls,1,'discovery must be bounded by its cache TTL');
  await refreshOllamaModels(registry,async()=>{throw new Error('Mac asleep');},16_001);
  assert.equal(registry.ollama?.online,false);
  assert.deepEqual(registry.ollama?.modelIds,['qwen3:4b','qwen3-coder:30b'],'offline must retain known models');
  await refreshOllamaModels(registry,async()=>new Response(JSON.stringify({data:[{id:'qwen3-coder:30b'}]})),32_000);
  assert.deepEqual(registry.ollama?.modelIds,['qwen3-coder:30b'],'removed models should no longer be offered');
});
test('Ollama discovery deduplicates concurrent reads and caps the catalog size',async()=>{
  const registry=loadRelayModels({RELAY_OLLAMA_URL:'http://127.0.0.1:11434/v1'});
  let calls=0;
  let resolve!: (response:Response)=>void;
  const pending=new Promise<Response>(done=>{resolve=done;});
  const request=async()=>{calls++;return pending;};
  const first=refreshOllamaModels(registry,request,1000);
  const second=refreshOllamaModels(registry,request,1000);
  resolve(new Response(JSON.stringify({data:Array.from({length:20},(_,i)=>({id:'qwen'+i+':1b'}))})));
  await Promise.all([first,second]);
  assert.equal(calls,1);
  assert.equal(registry.ollama?.modelIds.length,8);
  assert.equal(registry.models.length,9);
});
