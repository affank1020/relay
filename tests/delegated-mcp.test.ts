import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CapabilityRegistry } from '../src/capabilities.js';
import { Engine, type Limits } from '../src/engine.js';
import { ConnectionManager, configuredProviders } from '../src/integrations/manager.js';
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
  let dispatched=0, discovered=0;
  const registry=new CapabilityRegistry(folder,join(process.cwd(),'skills'),
    configuredProviders({RELAY_GITHUB_TOKEN:'private-secret'}),()=>({
      list:async()=>{discovered++;return [
        {name:'issue_read',inputSchema:{type:'object',additionalProperties:false}},
        {name:'get_file_contents',inputSchema:{type:'object',additionalProperties:false}},
        {name:'create_issue',inputSchema:{type:'object',additionalProperties:false}}
      ];},
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
        const delegateSchema=JSON.stringify(request.tools.find(t=>t.name==='relay_delegate')!.parameters);
        assert.match(delegateSchema,/"const":"mcp_github_issue_read"/);
        assert.match(delegateSchema,/"const":"mcp_github_get_file_contents"/);
        assert.doesNotMatch(delegateSchema,/mcp_github_create_issue/);
        await assert.rejects(delegate(request,'missing GitHub grant',
          {profile:'researcher',requiredToolProvider:'github'}),/GitHub MCP read tools are unavailable or not granted/);
        await delegate(request,'scoped child',
          {profile:'researcher',requiredToolProvider:'github',tools:['mcp_github_issue_read']});
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
    assert.equal(discovered,2,'only root and explicitly scoped child should discover MCP tools');
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

test('a delegated agent without MCP grants never discovers configured providers',async()=>{
  const store=new Store(':memory:');
  const github=configuredProviders({RELAY_GITHUB_TOKEN:'private'})[0];
  const other={...github,id:'other',label:'Other',readTools:['get_file_contents']};
  const visited:string[]=[];
  const manager=new ConnectionManager([github,other],()=>true,config=>({
    list:async()=>{visited.push(config.id);return [
      {name:'issue_read',inputSchema:{type:'object'}},
      {name:'get_file_contents',inputSchema:{type:'object'}}
    ];},
    call:async()=>{throw Error('not expected');},
    close:async()=>{}
  }));
  const delegation={schemaVersion:1 as const,toolNames:[] as string[],modelKey:null,
    context:'',maxTokens:null,maxCostUsd:null};
  const task:Task={id:crypto.randomUUID(),conversationId:crypto.randomUUID(),
    parentId:crypto.randomUUID(),requestId:'no-tools-test',prompt:'test',
    createdAt:new Date().toISOString(),state:'running',dependencies:[],
    attemptOf:null,result:'',error:null,usage:[],delegation};
  try{
    assert.deepEqual(await manager.tools(task,store,new AbortController().signal),[]);
    assert.deepEqual(visited,[],'unscoped child must make no provider network calls');
    delegation.toolNames=['atlas_get_atlas_status'];
    assert.deepEqual(await manager.tools(task,store,new AbortController().signal),[]);
    assert.deepEqual(visited,[],'Atlas-only delegation must not discover any MCP provider');
    delegation.toolNames=['mcp_github_issue_read'];
    assert.deepEqual((await manager.tools(task,store,new AbortController().signal))
      .map(tool=>tool.name),['mcp_github_issue_read']);
    assert.deepEqual(visited,['github'],'unrelated configured providers are not contacted');
  }finally{await manager.close();store.close();}
});

test('nested child handoff is parsed from final synthesized join output rather than initial text',async()=>{
  const store=new Store(':memory:');
  const initial='X'.repeat(8500);
  const finalReport=JSON.stringify({relayHandoff:{summary:'Nested final evidence',
    evidence:[{label:'Source of truth',url:'https://example.org/final'}],
    artifacts:[],openQuestions:['Is confirmation necessary?']},notes:'N'.repeat(8200)});
  const seen:string[]=[];
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root'){
        await delegate(request,'nested reviewer',{profile:'reviewer'});
        return 'Root awaiting child.';
      }
      if(request.task.prompt.startsWith('nested reviewer')){
        await delegate(request,'grandchild result');
        return initial;
      }
      if(request.task.prompt==='grandchild result')
        return 'Grandchild observed evidence.';
      if(request.task.kind==='join'){
        const parent=store.get<Task>('tasks',request.task.continuationOf!)!;
        if(parent.parentId){
          assert.match(request.task.prompt,/Delegated role \(Reviewer\)/,
            'nested join must request the selected role output contract');
          request.onText(finalReport.slice(0,100));
          return finalReport;
        }
        seen.push(request.task.prompt);
        assert.match(request.task.prompt,/Nested final evidence/);
        assert.match(request.task.prompt,/example.org\/final/);
        assert.match(request.task.prompt,/"structured":true/);
        assert.doesNotMatch(request.task.prompt,/X{200}/,
          'pre-join output must not displace the final handoff');
        return 'Root answer includes nested final report';
      }
      throw Error('Unexpected '+request.task.prompt);
    }},limits);
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root','nested-handoff-root-1');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const nested=engine.tasks().find(t=>t.parentId===root.id)!;
    const nestedJoin=engine.tasks().find(t=>t.continuationOf===nested.id)!;
    assert.equal(nestedJoin.result,finalReport);
    assert.ok(store.get<Task>('tasks',nested.id)!.result.startsWith(initial));
    assert.equal(store.get<Task>('tasks',nested.id)!.handoff?.structured,true);
    assert.equal(store.get<Task>('tasks',nested.id)!.handoff?.summary,'Nested final evidence');
    assert.equal(store.get<Task>('tasks',nested.id)!.handoff?.evidence[0].url,'https://example.org/final');
    assert.equal(seen.length,1);
    assert.match(store.get<Task>('tasks',root.id)!.result,/Root answer includes nested final report/);
  }finally{await engine.stop();store.close();}
});

test('plain-text general child retains the tail of a normal 5,000-character report for parent synthesis',async()=>{
  const store=new Store(':memory:');
  const report='P'.repeat(4800)+' FINAL_FINDING_5000';
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root general'){
        await delegate(request,'report child');
        return 'Delegated.';
      }
      if(request.task.prompt==='report child')return report;
      if(request.task.kind==='join'){
        assert.match(request.task.prompt,/FINAL_FINDING_5000/,
          'the child result must not be reduced to the 2,000-character console fallback');
        assert.match(request.task.prompt,/"resultTruncated":false/);
        return 'Joined with end-of-report evidence';
      }
      throw Error('Unexpected '+request.task.prompt);
    }},limits);
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root general','plain-general-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const child=engine.tasks().find(t=>t.parentId===root.id)!;
    assert.equal(child.handoff?.structured,false);
    assert.equal(child.handoff?.summary.length,2000,
      'compact task detail may remain bounded without reducing parent synthesis');
    assert.match(store.get<Task>('tasks',root.id)!.result,/Joined with end-of-report evidence/);
  }finally{await engine.stop();store.close();}
});

test('nested plain-text synthesis uses its final continuation, not pre-join transcript or 2K summary',async()=>{
  const store=new Store(':memory:');
  const initial='PRELIMINARY_'.repeat(900);
  const finalReport='S'.repeat(5100)+' FINAL_NESTED_EVIDENCE';
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root nested plain'){
        await delegate(request,'nested plain child');
        return 'Root delegated.';
      }
      if(request.task.prompt==='nested plain child'){
        await delegate(request,'leaf');
        return initial;
      }
      if(request.task.prompt==='leaf')return 'Leaf completed.';
      if(request.task.kind==='join'){
        const owner=store.get<Task>('tasks',request.task.continuationOf!)!;
        if(owner.parentId){
          request.onText(finalReport.slice(0,50));
          return finalReport;
        }
        assert.match(request.task.prompt,/FINAL_NESTED_EVIDENCE/);
        assert.doesNotMatch(request.task.prompt,/PRELIMINARY_PRELIMINARY_/);
        assert.match(request.task.prompt,/"resultTruncated":false/);
        return 'Root has the final nested result';
      }
      throw Error('Unexpected '+request.task.prompt);
    }},limits);
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root nested plain','plain-nested-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const nested=engine.tasks().find(t=>t.parentId===root.id)!;
    assert.equal(nested.handoff?.structured,false);
    assert.ok(nested.result.startsWith(initial),'the chat still retains earlier streaming history');
    const join=engine.tasks().find(t=>t.continuationOf===nested.id)!;
    assert.equal(join.result,finalReport);
    assert.match(store.get<Task>('tasks',root.id)!.result,/Root has the final nested result/);
  }finally{await engine.stop();store.close();}
});

test('tool-less researcher is warned about the lack of independent verification',async()=>{
  const store=new Store(':memory:');
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root research'){
        const delegateTool=request.tools.find(t=>t.name==='relay_delegate')!;
        const schema=delegateTool.parameters as {properties:{tools:{maxItems:number}}};
        assert.equal(schema.properties.tools.maxItems,0);
        const serialized=JSON.stringify(delegateTool.parameters);
        assert.match(serialized,/"maxItems":0/);
        await delegate(request,'Verify latest independent research',{profile:'researcher'});
        return 'Awaiting research.';
      }
      if(request.task.kind==='join'){
        assert.match(request.task.prompt,/No external verification was possible/);
        return 'No live verification available.';
      }
      if(request.task.prompt.startsWith('Verify latest independent research')){
        assert.deepEqual(request.tools.map(tool=>tool.name),['relay_delegate']);
        assert.match(request.task.prompt,/Verification limitation: No external read tools/);
        assert.match(request.task.prompt,/never invent citations or tool execution/);
        return JSON.stringify({relayHandoff:{
          summary:'No external verification was possible',evidence:[],artifacts:[],
          openQuestions:['Provide an approved research source.']
        }});
      }
      throw new Error('Unexpected task '+request.task.prompt);
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const c=engine.conversation(),root=engine.enqueue(c.id,'root research','no-read-tools-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const child=engine.tasks().find(task=>task.parentId===root.id)!;
    assert.deepEqual(child.delegation?.toolNames,[]);
    assert.equal(child.handoff?.summary,'No external verification was possible');
    assert.match(store.get<Task>('tasks',root.id)!.result,/No live verification available/);
  }finally{await engine.stop();store.close();}
});

test('repeated identical Pi delegation reuses a single child while distinct work still runs',async()=>{
  const store=new Store(':memory:');
  const dispatched:string[]=[];
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root duplicate'){
        const first=await delegate(request,'Read issue #28',{profile:'researcher'});
        const duplicate=await delegate(request,'Read issue #28',{profile:'researcher'});
        const second=await delegate(request,'Read issue #29',{profile:'researcher'});
        const issued=(value:typeof first)=>JSON.parse((value.content[0] as {text:string}).text)
          as {taskId:string;reused:boolean};
        assert.equal(issued(first).reused,false);
        assert.equal(issued(duplicate).reused,true);
        assert.equal(issued(second).reused,false);
        assert.equal(issued(first).taskId,issued(duplicate).taskId);
        return 'Delegated two distinct tasks.';
      }
      if(request.task.kind==='join'){
        assert.match(request.task.prompt,/Read issue #28/);
        assert.match(request.task.prompt,/Read issue #29/);
        return 'Both child reports synthesised.';
      }
      dispatched.push(request.task.prompt);
      return JSON.stringify({relayHandoff:{summary:request.task.prompt,
        evidence:[],artifacts:[],openQuestions:[]}});
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const conversation=engine.conversation();
    const root=engine.enqueue(conversation.id,'root duplicate','dedup-root-001');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    const children=engine.tasks().filter(t=>t.parentId===root.id);
    assert.equal(children.length,2);
    assert.equal(dispatched.length,2);
    assert.ok(dispatched.some(prompt=>prompt.startsWith('Read issue #28')));
    assert.ok(dispatched.some(prompt=>prompt.startsWith('Read issue #29')));
  }finally{await engine.stop();store.close();}
});

test('required GitHub tool provider fails admission without any GitHub tools',async()=>{
  const store=new Store(':memory:');
  const harness:Harness={version:1,capabilities:{persistence:true,cancellation:true,tools:true},
    run:async request=>{
      if(request.task.prompt==='root provider'){
        const schema=JSON.stringify(request.tools.find(t=>t.name==='relay_delegate')!.parameters);
        assert.match(schema,/requiredToolProvider/);
        await assert.rejects(delegate(request,'Use GitHub MCP to read issue #28',
          {profile:'researcher',requiredToolProvider:'github'}),
          /GitHub MCP read tools are unavailable or not granted/);
        return 'External research was not started without tools.';
      }
      return 'Unexpected child';
    }};
  const engine=new Engine(store,harness,limits);
  try{
    const conversation=engine.conversation(),root=engine.enqueue(conversation.id,'root provider','no-github-root');
    await until(()=>store.get<Task>('tasks',root.id)?.state==='completed');
    assert.equal(engine.tasks().filter(t=>t.parentId===root.id).length,0);
    assert.match(store.get<Task>('tasks',root.id)!.result,/not started/);
  }finally{await engine.stop();store.close();}
});
