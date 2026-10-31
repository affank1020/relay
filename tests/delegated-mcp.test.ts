import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CapabilityRegistry } from '../src/capabilities.js';
import { Engine, type Limits } from '../src/engine.js';
import { configuredProviders } from '../src/integrations/manager.js';
import { Store, type Task } from '../src/store.js';
import type { Harness, HarnessRequest } from '../src/harness.js';

const limits:Limits={concurrency:2,queue:64,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000};
async function until(fn:()=>boolean){for(let i=0;i<1000;i++){if(fn())return;await delay(5);}throw new Error('Timed out');}
async function delegate(request:HarnessRequest,prompt:string,args:Record<string,unknown>={}){
  const tool=request.tools.find(t=>t.name==='relay_delegate');
  assert.ok(tool);
  return tool.execute('delegate-'+prompt,{prompt,...args},request.signal,undefined,{} as never);
}

test('child profiles use only explicitly selected MCP read tools and persist structured handoffs',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'relay-profile-mcp-'));
  const store=new Store(':memory:');
  let dispatched=0;
  const registry=new CapabilityRegistry(folder,join(process.cwd(),'skills'),
    configuredProviders({RELAY_GITHUB_TOKEN:'private-secret'}),()=>({
      list:async()=>[
        {name:'issue_read',inputSchema:{type:'object',additionalProperties:false}},
        {name:'get_file_contents',inputSchema:{type:'object',additionalProperties:false}},
        {name:'create_issue',inputSchema:{type:'object',additionalProperties:false}}
      ],
      call:async()=>{dispatched++;return {content:[{type:'text',text:'fixture read'}]};},
      close:async()=>{}
    }));
  await registry.update('integrations','github',true);
  const observed:string[]=[];
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root'){
        assert.ok(request.tools.some(t=>t.name==='mcp_github_issue_read'));
        assert.ok(request.tools.some(t=>t.name==='mcp_github_get_file_contents'));
        assert.ok(!request.tools.some(t=>t.name==='mcp_github_create_issue'));
        await delegate(request,'scoped child',{profile:'researcher',tools:['mcp_github_issue_read']});
        await delegate(request,'isolated child',{profile:'reviewer'});
        return 'Delegated safely.';
      }
      if(request.task.kind==='join'){
        assert.deepEqual(request.tools,[]);
        assert.match(request.task.prompt,/agent_reported/);
        assert.match(request.task.prompt,/Source evidence/);
        assert.match(request.task.prompt,/No external tools used/);
        return 'Synthesised safely.';
      }
      if(request.task.prompt.startsWith('scoped child')){
        observed.push(request.task.delegation?.profile??'missing');
        assert.match(request.task.prompt,/Delegated role \(Researcher\)/);
        assert.deepEqual(request.tools.map(t=>t.name),['mcp_github_issue_read','relay_delegate']);
        const tool=request.tools[0];
        await tool.execute('read-1',{},request.signal,undefined,{} as never);
        const stored=store.get<Task>('tasks',request.task.id)!;
        store.save('tasks',{...stored,delegation:{...stored.delegation!,toolNames:[]}});
        await assert.rejects(tool.execute('revoked-1',{},request.signal,undefined,{} as never),
          /MCP tool is not permitted/);
        store.save('tasks',stored);
        return JSON.stringify({relayHandoff:{summary:'Source evidence',
          evidence:[{label:'Source',url:'https://example.org/'}],artifacts:[],
          openQuestions:['What changed?']}});
      }
      if(request.task.prompt.startsWith('isolated child')){
        observed.push(request.task.delegation?.profile??'missing');
        assert.match(request.task.prompt,/Delegated role \(Reviewer\)/);
        assert.deepEqual(request.tools.map(t=>t.name),['relay_delegate']);
        return JSON.stringify({relayHandoff:{summary:'No external tools used',
          evidence:[],artifacts:[],openQuestions:[]}});
      }
      throw new Error('unexpected task '+request.task.prompt);
    }};
  const engine=new Engine(store,harness,limits,undefined,{},undefined,registry);
  try{
    const conversation=engine.conversation(),parent=engine.enqueue(conversation.id,'root','parent-profile-001');
    await until(()=>store.get<Task>('tasks',parent.id)?.state==='completed');
    const children=engine.tasks().filter(t=>t.parentId===parent.id);
    assert.equal(children.length,2);
    assert.deepEqual([...observed].sort(),['researcher','reviewer']);
    assert.deepEqual(children.map(t=>t.handoff?.structured),[true,true]);
    assert.ok(children.every(t=>t.handoff?.provenance==='agent_reported'));
    assert.equal(dispatched,1,'revoked invocation must never reach MCP provider');
    const read=store.events(children[0].conversationId).filter(e=>e.tool==='github:issue_read');
    assert.ok(read.length>=3);
    assert.ok(read.every(e=>e.agentRunId===children[0].agentRunId));
    assert.match(store.get<Task>('tasks',parent.id)!.result,/Synthesised safely/);
  }finally{await engine.stop();store.close();await registry.close();await rm(folder,{recursive:true,force:true});}
});

test('delegated profile tool requests are rejected when only an unauthorized MCP tool is named',async()=>{
  const store=new Store(':memory:');
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root'){
        await assert.rejects(delegate(request,'bad child',{
          profile:'implementer',tools:['mcp_github_create_issue']}),/read-only/);
        await assert.rejects(delegate(request,'unknown role',{profile:'administrator'}),/Unknown agent profile/);
        return 'denied';
      }
      return 'unexpected';
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root','deny-profile-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    assert.equal(engine.tasks().length,1);
    assert.equal(store.all('conversations').length,1);
  }finally{await engine.stop();store.close();}
});
