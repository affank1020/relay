import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { PiHarness } from '../src/harness.js';
import { startOllamaProxy } from '../src/ollama-proxy.js';
import { loadRelayModels } from '../src/models.js';
import type { Task } from '../src/store.js';

// Real Pi -> mocked Ollama OpenAI-compatible API. Reject any request that
// doesn't preserve the loopback Host header. No external inference is used.
test('Pi local model preflight and streamed inference send Ollama loopback Host header', {timeout:65000}, async()=>{
  const seen:string[]=[];
  const server=createServer((req,res)=>{
    seen.push(req.method+' '+req.url+' '+req.headers.host);
    if(req.headers.host!=='localhost:11434'){
      res.writeHead(403);res.end();return;
    }
    if(req.method==='GET'&&req.url==='/v1/models'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:'qwen3:4b',object:'model'}]}));return;
    }
    if(req.method==='POST'&&req.url==='/v1/chat/completions'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const base={id:'test-completion',object:'chat.completion.chunk',created:1,model:'qwen3:4b'};
      res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Ollama connected'},finish_reason:null}]})+'\n\n');
      res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
      res.end('data: [DONE]\n\n');return;
    }
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Expected local TCP server');
  const root=await mkdtemp(join(tmpdir(),'relay-ollama-host-'));
  const registry=loadRelayModels({RELAY_OLLAMA_URL:'http://127.0.0.1:'+address.port+'/v1'});
  const proxy=await startOllamaProxy(registry.ollama!.baseUrl);
  registry.ollama!.baseUrl=proxy.baseUrl;
  const task:Task={id:randomUUID(),conversationId:randomUUID(),requestId:'host-check-01',
    prompt:'Say connected',state:'running',createdAt:new Date().toISOString(),parentId:null,
    dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  try{
    const result=await new PiHarness(root,registry.models[0].id,registry).run({
      version:1,task,modelKey:'ollama/qwen3:4b',signal:new AbortController().signal,
      tools:[],onText:()=>{},onUsage:()=>{}
    });
    assert.match(result,/Ollama connected/);
    assert.deepEqual(registry.ollama?.modelIds,['qwen3:4b'],'Pi should accept a model discovered after startup');
    assert.ok(seen.some(x=>x==='GET /v1/models localhost:11434'),'preflight must rewrite host');
    assert.ok(seen.some(x=>x==='POST /v1/chat/completions localhost:11434'),'Pi inference must rewrite host');
  }finally{
    await proxy.close();
    server.closeAllConnections();server.close();
    await rm(root,{recursive:true,force:true});
  }
});
