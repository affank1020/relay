import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectAgentProgress } from '../src/agent-progress.js';
import type { Task, State } from '../src/store.js';
import { agentHandoff } from '../src/handoff.js';

const time='2026-10-31T20:00:00.000Z';
function make(id:string,parentId:string|null,state:State='completed'):Task {
  return {id,conversationId:parentId?'internal-'+id:'chat',requestId:id,
    prompt:'Work '+id,createdAt:time,parentId,state,dependencies:[],attemptOf:null,
    result:'raw private child output '+id,error:null,usage:[]};
}

test('inline agent progress uses durable parent-child identities, stable order and bounded reported data',()=>{
  const root=make('root',null);
  const a=make('a','root','completed'),b=make('b','root','awaiting_approval');
  const grandchild=make('grandchild','a','running');
  const unrelated=make('unrelated','foreign','completed');
  a.delegation={schemaVersion:1,profile:'researcher',toolNames:[],modelKey:null,
    context:'private context',maxTokens:null,maxCostUsd:null};
  a.prompt='Investigate the source of the failure '+('Q'.repeat(400));
  a.handoff=agentHandoff(JSON.stringify({relayHandoff:{
    summary:'S'.repeat(270),evidence:[],artifacts:[],openQuestions:[]
  }}));
  a.usage=[{input:12,output:6,cacheRead:2,cacheWrite:1,costUsd:0.001,costKind:'estimated'}];
  b.dependencies=['a'];
  const join=make('join','root');join.kind='join';
  const snapshot=projectAgentProgress([root],[b,unrelated,grandchild,root,a,join],task=>
    task.id==='b'?{name:'mcp_github_issue_read',state:'started'}:null);
  assert.deepEqual(Object.keys(snapshot),['root']);
  const result=snapshot.root;
  assert.deepEqual(result.map(x=>x.id),['a','grandchild','b']);
  assert.deepEqual(result.map(x=>x.depth),[1,2,1]);
  assert.deepEqual(result.map(x=>x.role),['researcher','general','general']);
  assert.deepEqual(result[2].dependencies,['a']);
  assert.deepEqual(result[2].lastTool,{name:'mcp_github_issue_read',state:'started'});
  assert.equal(result[0].tokens,21);
  assert.equal(result[0].costUsd,.001);
  assert.equal(result[0].reportedSummary?.length,240);
  assert.equal(result[1].reportedSummary,null);
  assert.ok(result[0].prompt.length<=180);
  assert.ok(!JSON.stringify(result).includes('private context'));
  assert.ok(!JSON.stringify(result).includes('raw private child output'));
  assert.ok(!JSON.stringify(result).includes('unrelated'));
});

test('terminal states are projected after restart with no reliance on prior event replay',()=>{
  const root=make('root',null,'completed');
  const child=make('child','root','failed');
  child.agentRunId='real-run-id';child.modelKey='openrouter/actual';
  child.usage=[{input:null,output:10,cacheRead:0,cacheWrite:0,costUsd:null,costKind:'unknown'}];
  const first=projectAgentProgress([root],[root,child]);
  const recovered=projectAgentProgress([root],[JSON.parse(JSON.stringify(root)),JSON.parse(JSON.stringify(child))]);
  assert.deepEqual(first,recovered);
  assert.equal(recovered.root[0].state,'failed');
  assert.equal(recovered.root[0].agentRunId,'real-run-id');
  assert.equal(recovered.root[0].tokens,null);
  assert.equal(recovered.root[0].costUsd,null);
  assert.deepEqual(projectAgentProgress([root],[root]).root,[]);
});

test('malformed ancestry cycles and excessive fan-out do not expand an unbounded projection',()=>{
  const root=make('root',null);
  const children=Array.from({length:35},(_,index)=>make('child-'+index,'root'));
  const snapshot=projectAgentProgress([root],[root,...children]);
  assert.equal(snapshot.root.length,20);
  const nested=make('nested',snapshot.root[0].id);
  const cycle=make('root',nested.id);
  const checked=projectAgentProgress([root],[root,...children,nested,cycle]);
  assert.ok(checked.root.length<=20);
  assert.ok(checked.root.every(item=>item.depth<=2));
});
