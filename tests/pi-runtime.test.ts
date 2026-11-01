import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PiHarness } from '../src/harness.js';
import { Store, type Task } from '../src/store.js';
import { PiSubagentLedger } from '../src/pi-subagent-ledger.js';

// Only the external model and MCP service are fixtures. Pi's agent loop,
// extension loading, tools, MCP client, sessions and event buses are real.
for(const scenario of ['parallel','sequential','failure','denied','cancelled','atlas'] as const)
test('real Pi delegation: '+scenario,async()=>{
  const provider=scenario==='atlas'?'atlas':'github';
  const tool=scenario==='atlas'?'get_node':'issue_read';
  const nodes:string[]=[randomUUID(),randomUUID()];
  const root=await mkdtemp(join(tmpdir(),'relay-real-pi-'));
  const store=new Store(':memory:');
  let active=0,maxActive=0;
  const reads:number[]=[];
  const controller=new AbortController();
  const modelRequests:any[]=[];
  const service=createServer(async(req,res)=>{
    try {
      if(req.url==='/mcp'){
        const mcp=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
        mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:tool,description:'Read source',inputSchema:scenario==='atlas'?{type:'object',properties:{nodeId:{type:'string'}},required:['nodeId']}:{type:'object',properties:{issue_number:{type:'number'}},required:['issue_number']}}]}));
        mcp.setRequestHandler(CallToolRequestSchema,async request=>{
          assert.equal(request.params.name,tool);
          const n=scenario==='atlas'?nodes.indexOf(String(request.params.arguments?.nodeId))+28:Number(request.params.arguments?.issue_number);
          active++;maxActive=Math.max(maxActive,active);
          if(scenario==='cancelled')setTimeout(()=>controller.abort(),20);
          await new Promise(resolve=>setTimeout(resolve,100));
          reads.push(n);active--;
          return {...(scenario==='atlas'?{structuredContent:{result:{node:{id:nodes[n-28],name:'Fixture Node',status:'online'}}}}:{}),isError:scenario==='failure'&&n===29,content:[{type:'text',text:scenario==='failure'&&n===29?'Source unavailable':`Retrieved issue ${n}`} ]};
        });
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
        await mcp.connect(transport);
        res.on('close',()=>{void mcp.close();});
        await transport.handleRequest(req,res);
        return;
      }
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);modelRequests.push(request);
      const messages=request.messages as any[];
      const content=messages.filter(m=>m.role==='user').at(-1)?.content??'';
      const user=Array.isArray(content)?content.map(p=>p.text??'').join(''):content;
      const toolResults=messages.filter(m=>m.role==='tool');
      let name:string|undefined,args:unknown;
      let answer='';
      if(String(user).includes('parallel issues')) {
        if(!toolResults.length){name='delegate';args={mode:scenario==='sequential'?'sequential':'parallel',tasks:[28,29].map(n=>({prompt:`Read issue ${n}`,tools:[scenario==='denied'?'bash':`mcp__${provider}__${tool}`]}))};}
        else {if(scenario==='parallel'||scenario==='sequential'||scenario==='atlas'){assert.match(JSON.stringify(toolResults),/Retrieved issue 28/);assert.match(JSON.stringify(toolResults),/Retrieved issue 29/);answer='Verified issues 28 and 29.';}else answer='Not all research was verified.';}
      }else{
        const n=Number(String(user).match(/issue (\d+)/)?.[1]);
        if(!toolResults.length){name='tool_search';args={query:tool};}
        else if(toolResults.length===1){name=`mcp__${provider}__${tool}`;args=scenario==='atlas'?{nodeId:nodes[n-28]}:{issue_number:n};}
        else {if(scenario==='failure'&&n===29)answer='Source unavailable';else {assert.match(JSON.stringify(toolResults),new RegExp(`Retrieved issue ${n}`));answer=`Retrieved issue ${n}`;}}
      }
      const delta=name?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:answer};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=(choices:unknown[],usage?:unknown)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:'fixture:free',choices,usage})+'\n\n');
      emit([{index:0,delta:{role:'assistant',...delta},finish_reason:null}]);
      emit([{index:0,delta:{},finish_reason:name?'tool_calls':'stop'}],{prompt_tokens:10,completion_tokens:5,total_tokens:15});
      res.end('data: [DONE]\n\n');
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  service.listen(0,'127.0.0.1');await once(service,'listening');
  const url='http://127.0.0.1:'+(service.address() as {port:number}).port;
  try {
    const runtime=await ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,authPath:join(root,'auth.json'),modelsPath:null});
    runtime.registerProvider('openrouter',{baseUrl:url,api:'openai-completions',apiKey:'fixture',models:['fixture:free','second:free'].map(id=>({id,name:'Fixture',reasoning:false,input:['text' as const],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}))});
    const registry={defaultKey:'openrouter/fixture:free',models:['fixture:free','second:free'].map(id=>({id,key:'openrouter/'+id,provider:'openrouter' as const,label:id}))};
    const harness=new PiHarness(root,'fixture:free',registry,undefined,runtime);
    const conversationId=randomUUID();store.save('conversations',{id:conversationId,title:'fixture',createdAt:new Date().toISOString()});
    const task:Task={id:randomUUID(),conversationId,requestId:randomUUID(),prompt:'Research parallel issues',state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[],agentRunId:randomUUID()};
    store.save('tasks',task);
    const ledger=new PiSubagentLedger(store,task);
    const running=harness.run({version:1,task,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),tools:[],
      nativeMcp:{task,store,providers:[{config:{id:provider,label:provider,url:url+'/mcp',token:'fixture',readTools:[tool]},enabled:()=>true}]},
      onSubagent:event=>{ledger.record(event);},onChildUsage:event=>{ledger.recordUsage(event.agentId,{...event.usage,costKind:'estimated'});},
      onChildRead:(id,tool,success)=>ledger.recordRead(id,tool,success),onText:()=>{},onUsage:()=>{}});
    if(scenario==='cancelled'){await assert.rejects(running);assert.ok(store.all<Task>('tasks').filter(t=>t.parentId===task.id).every(t=>t.state==='cancelled'));return;}
    const result=await running;
    if(scenario==='denied'){assert.equal(reads.length,0);assert.equal(store.all<Task>('tasks').length,1);return;}
    assert.equal(result,scenario==='failure'?'Not all research was verified.':'Verified issues 28 and 29.');
    assert.deepEqual(reads.sort(),[28,29]);assert.equal(maxActive,scenario==='sequential'?1:2);
    const children=store.all<Task>('tasks').filter(t=>t.parentId===task.id);
    assert.equal(children.length,2);assert.equal(children.filter(t=>t.state==='completed').length,scenario==='failure'?1:2);
    assert.notEqual(children[0].conversationId,children[1].conversationId);
    for(const child of children){
      assert.equal((await readdir(join(root,'sessions',child.conversationId))).filter(n=>n.endsWith('.jsonl')).length,1);
      assert.ok(child.usage.length>0);
      if(scenario==='atlas')assert.ok(store.events(child.conversationId).some(event=>event.atlasResource?.node?.status==='online'));
      assert.ok(store.invocationRecords(child.id).some(r=>r.state===(child.state==='completed'?'completed':'failed_read')));
    }
    assert.ok(modelRequests.length>=6);
    if(scenario==='parallel'){
      const restored=new PiHarness(root,'fixture:free',registry,undefined,runtime);
      const before=await restored.snapshot(conversationId) as {id:string;messages:unknown[]};
      assert.ok(before.messages.length>=3);
      await restored.run({version:1,task:{...task,prompt:'Research parallel issues again'},modelKey:'openrouter/second:free',signal:AbortSignal.timeout(5000),tools:[],onText:()=>{},onUsage:()=>{}});
      const after=await restored.snapshot(conversationId) as {id:string;model:{modelId:string};messages:unknown[]};
      assert.equal(after.id,before.id);assert.equal(after.model.modelId,'second:free');
      assert.ok(after.messages.length>before.messages.length);
      assert.equal(reads.length,2,'resuming must not replay prior MCP effects');
    }
  }finally{service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true});}
});
