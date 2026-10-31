import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadRelayModels} from '../src/models.js';

test('local model configuration supports private Tailscale and loopback but rejects public endpoints',()=>{
  const cloud=loadRelayModels({});
  assert.equal(cloud.models.length,1);
  assert.equal(cloud.models[0].provider,'openrouter');
  const local=loadRelayModels({RELAY_OLLAMA_URL:'https://mac.example-tailnet.ts.net/v1',RELAY_OLLAMA_MODELS:'qwen3:4b,qwen3:8b'});
  assert.deepEqual(local.models.map(m=>m.key),[cloud.defaultKey,'ollama/qwen3:4b','ollama/qwen3:8b']);
  assert.equal(local.ollama?.baseUrl,'https://mac.example-tailnet.ts.net/v1');
  assert.equal(loadRelayModels({RELAY_OLLAMA_URL:'http://127.0.0.1:11434/v1',RELAY_OLLAMA_MODELS:'qwen3:4b'}).models.length,2);
  for(const endpoint of ['https://example.com/v1','http://192.168.1.10:11434/v1','https://mac.ts.net/v1?token=oops','https://mac.ts.net:8443/v1','https://mac.ts.net@attacker.example/v1']){
    assert.throws(()=>loadRelayModels({RELAY_OLLAMA_URL:endpoint,RELAY_OLLAMA_MODELS:'qwen3:4b'}),/Tailscale/);
  }
  assert.throws(()=>loadRelayModels({RELAY_OLLAMA_MODELS:'qwen3:4b'}),/configured together/);
  assert.throws(()=>loadRelayModels({RELAY_OLLAMA_URL:'https://mac.ts.net/v1',RELAY_OLLAMA_MODELS:'qwen3:4b,qwen3:4b'}),/Invalid Ollama model/);
  assert.throws(()=>loadRelayModels({RELAY_MODEL:'paid-model'}),/explicit :free/);
});
