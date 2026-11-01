import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { recoverQwenToolCall } from '../src/qwen-ollama-tools.js';
import { startOllamaProxy } from '../src/ollama-proxy.js';
import { PiHarness } from '../src/harness.js';
import { loadRelayModels } from '../src/models.js';
import type { Task } from '../src/store.js';

const readTool=[{type:'function',function:{name:'demo_issue_read',
  parameters:{type:'object',properties:{issue_number:{type:'number'}}}}}];
const output=(content:string)=>({id:'chatcmpl-01',model:'qwen3-coder:30b',
  choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]});
const broken='I will read the issue.\n\n<function=demo_issue_read>\n'+
  '<parameter=issue_number>29</parameter>\n</function>\n</tool_call>';

test('Recover only a request-advertised, bounded Qwen3-Coder function into a genuine tool call',()=>{
  const parsed=recoverQwenToolCall(output(broken),readTool);
  assert.equal(parsed.kind,'recovered');
  const m=parsed.completion.choices![0].message!;
  assert.equal(m.content,null);
  const call=m.tool_calls![0] as {function:{name:string;arguments:string}};
  assert.equal(call.function.name,'demo_issue_read');
  assert.deepEqual(JSON.parse(call.function.arguments),{issue_number:29});
  assert.equal(recoverQwenToolCall(output(broken),[]).kind,'invalid');
  assert.equal(recoverQwenToolCall(output(broken.replace('demo_issue_read','github_write_issue')),readTool).kind,'invalid');
  assert.equal(recoverQwenToolCall(output(broken.replace('29','<script>')),readTool).kind,'invalid');
  assert.equal(recoverQwenToolCall(output('An ordinary response'),readTool).kind,'none');
});

test('Existing structured provider calls are preserved, never reparsed or duplicated',()=>{
  const raw={...output(''),choices:[{index:0,finish_reason:'tool_calls',
    message:{role:'assistant',content:null,tool_calls:[{id:'call_a',type:'function',
      function:{name:'demo_issue_read',arguments:'{"issue_number":29}'}}]}}]};
  const parsed=recoverQwenToolCall(raw,readTool);
  assert.equal(parsed.kind,'none');
  assert.strictEqual(parsed.completion,raw);
});

test('Real PiHarness executes recovered Ollama Qwen calls rather than showing XML', {timeout:65000},async()=>{
  let upstreamCalls=0,executed=0,malformedWasRequested=false;
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:[{id:'qwen3-coder:30b'}]}));return;
    }
    if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
    const chunks:Buffer[]=[];
    for await(const c of req)chunks.push(c as Buffer);
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8')) as
      {stream?:boolean;tools?:Array<{function:{name:string}}>;messages?:unknown[]};
    upstreamCalls++;
    malformedWasRequested ||=payload.stream===false;
    if(upstreamCalls===1){
      assert.ok(payload.tools?.some(t=>t.function.name==='demo_issue_read'),
        'Pi must advertise a real tool in the Ollama request');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({...output(broken),usage:{prompt_tokens:50,completion_tokens:40,
        total_tokens:90}}));
      return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(output('Verified source: Relay multi-agent orchestration V2')));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();
  if(!address||typeof address==='string')throw Error('Missing mock Ollama address');
  const root=await mkdtemp(join(tmpdir(),'relay-qwen-tools-'));
  const registry=loadRelayModels({RELAY_OLLAMA_URL:
    'http://127.0.0.1:'+address.port+'/v1'});
  const proxy=await startOllamaProxy(registry.ollama!.baseUrl);
  registry.ollama!.baseUrl=proxy.baseUrl;
  const task:Task={id:randomUUID(),conversationId:randomUUID(),
    requestId:'qwen-tool-smoke',prompt:'Use demo_issue_read to read issue 29',
    state:'running',createdAt:new Date().toISOString(),parentId:null,
    dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  try {
    const result=await new PiHarness(root,registry.models[0].id,registry).run({
      version:1,task,modelKey:'ollama/qwen3-coder:30b',
      signal:new AbortController().signal,
      tools:[{name:'demo_issue_read',label:'Read issue',description:'Read issue by number',
        parameters:Type.Object({issue_number:Type.Number()}),
        execute:async (_id,input)=>{
          assert.equal((input as {issue_number:number}).issue_number,29);
          executed++;
          return {content:[{type:'text' as const,text:'Issue #29 verified body'}],details:{}};
        }}],
      onText:()=>{},onUsage:()=>{}
    });
    assert.equal(executed,1,'Pi must actually invoke the tool');
    assert.ok(upstreamCalls>=2,'Pi must call the provider again after tool execution');
    assert.equal(malformedWasRequested,true);
    assert.match(result,/Verified source:/);
    assert.doesNotMatch(result,/<function=/);
  }finally {
    await proxy.close();server.closeAllConnections();server.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('Malformed Qwen tool blocks fail closed at proxy, not as a fake success',async()=>{
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
    for await(const _ of req){/* consume request */}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(output('<function=unapproved_write>\n<parameter=x>1</parameter>\n</function>')));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();
  if(!address||typeof address==='string')throw Error('Missing mock upstream');
  const proxy=await startOllamaProxy('http://127.0.0.1:'+address.port+'/v1');
  try {
    const response=await fetch(proxy.baseUrl+'/chat/completions',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({
        model:'qwen3-coder:30b',stream:true,
        messages:[{role:'user',content:'Read an issue'}],tools:readTool})});
    assert.equal(response.status,502);
    assert.doesNotMatch(await response.text(),/unapproved_write/);
  }finally{await proxy.close();server.closeAllConnections();server.close();}
});
