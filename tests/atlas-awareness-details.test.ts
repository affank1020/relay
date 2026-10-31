import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway, type AtlasTransport } from '../src/gateway.js';
import { Store, type Task } from '../src/store.js';
import { observeAtlasDetailResult,projectAtlasDetails,reviewPullRequestUrl } from '../src/atlas-awareness-details.js';
import { atlasDetailSummary } from '../src/atlas-awareness-details-ui.js';

const project='008b191b-96c2-4a5f-92f6-1f13d6d790d5';
const storeId='0140b619-4f75-454e-92a3-c8b595c9dee5';
const recordId='1fd91155-6511-4ca1-8079-8568fea4c1eb';
const runId='a2b558aa-1d00-4c6a-9192-428efa978f7a';
const gitHead='ff82ca0e08095dd29462440b4737978527ded5c9';
const structured=(data:unknown)=>({
  content:[{type:'text' as const,text:'SENSITIVE_PRIVATE_MCP_PAYLOAD'}],
  structuredContent:{result:data}
});
const fixtureSummary=()=>({
  repository:'affank1020/relay',prNumber:33,recordedRounds:3,
  latest:{runId,headSha:gitHead,reviewedAt:'2026-10-31T21:11:03.317Z',
    verdict:'no_findings',source:'structured',
    severityCounts:{sev1:0,sev2:0,sev3:0,sev4:0}},
  currentHead:{state:'closed',sha:gitHead,checkedAt:'2026-10-31T21:21:48.917Z'},
  latestReviewHead:'current'
});
const task=(id:string):Task=>({id,conversationId:'conv',agentRunId:'run-'+id} as Task & {agentRunId:string});

test('record, project and store reads emit identities without data, descriptions or schema',()=>{
  const sensitive='do_not_include_private_record_content';
  const record=observeAtlasDetailResult('get_record',
    {projectId:project,storeId,recordId},
    {id:recordId,projectId:project,storeId,data:{apiKey:sensitive,description:sensitive}});
  assert.equal(record?.detail?.kind,'record');
  assert.deepEqual(record?.resources.map(r=>r.type),['project','store','record']);
  assert.doesNotMatch(JSON.stringify(record),new RegExp(sensitive));
  assert.equal(observeAtlasDetailResult('get_record',
    {projectId:project,storeId,recordId},{id:recordId,projectId:project,storeId:runId}),null);
  assert.equal(observeAtlasDetailResult('get_record',
    {projectId:project,storeId,recordId},{id:runId}),null);
  const p=observeAtlasDetailResult('get_project',{projectId:project},
    {id:project,name:'Code Reviews',description:sensitive});
  assert.equal(p?.detail?.kind,'project');
  assert.doesNotMatch(JSON.stringify(p),new RegExp(sensitive));
  const store=observeAtlasDetailResult('get_store',{projectId:project,storeId},
    {id:storeId,projectId:project,name:'Review Runs',schema:{
      fields:[{name:'private',description:sensitive},{name:'secret',default:sensitive}]}});
  assert.equal(store?.detail?.kind,'store');
  assert.equal(store?.detail?.kind==='store'&&store.detail.fieldCount,2);
  assert.doesNotMatch(JSON.stringify(store),new RegExp(sensitive));
  assert.equal(observeAtlasDetailResult('get_store',{projectId:project,storeId},
    {id:storeId,projectId:runId}),null);
});

test('review summary preserves evidence, source timing and verified PR identity',()=>{
  const fact=observeAtlasDetailResult('code_reviews_pr_summary',
    {repository:'affank1020/relay',prNumber:33},fixtureSummary());
  assert.equal(fact?.detail?.kind,'review_pr');
  const d=fact!.detail!;
  assert.equal(d.kind==='review_pr'&&d.latestReviewHead,'current');
  assert.equal(d.kind==='review_pr'&&d.currentHead.state,'closed');
  assert.equal(reviewPullRequestUrl(d),'https://github.com/affank1020/relay/pull/33');
  assert.match(atlasDetailSummary(d).rows.join(' '),/No findings in this result/);
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',
    {repository:'someone/else',prNumber:33},fixtureSummary()),null);
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',
    {repository:'affank1020/relay',prNumber:34},fixtureSummary()),null);
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',
    {repository:'../private',prNumber:33},fixtureSummary()),null);
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',
    {repository:'affank1020/relay',prNumber:33},
    {...fixtureSummary(),latest:{...fixtureSummary().latest,headSha:'a'.repeat(40)}}),null,
    'a claim of current review must match the independently reported current PR head');
});

test('unknown and outdated review freshness never become a false clean claim',()=>{
  const args={repository:'affank1020/relay',prNumber:33};
  const unknown=observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),currentHead:{state:'unavailable'},latestReviewHead:'unknown'});
  assert.equal(unknown?.detail?.kind,'review_pr');
  assert.equal(unknown?.detail&&atlasDetailSummary(unknown.detail).status,'Review freshness unknown');
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),currentHead:{state:'unavailable'},latestReviewHead:'outdated'}),null,
    'outdated review cannot be asserted when GitHub is unavailable');
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),currentHead:{state:'open',sha:gitHead},latestReviewHead:'unknown'}),null,
    'unknown freshness contradicts a verified matching PR head');
  const outdated=observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),currentHead:{state:'open',sha:'a'.repeat(40)},
    latestReviewHead:'outdated'});
  assert.equal(outdated?.detail&&atlasDetailSummary(outdated.detail).status,'Review is outdated');
  const noStored=observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),recordedRounds:0,latest:null,
    latestReviewHead:'no_stored_review'});
  assert.equal(noStored?.detail&&atlasDetailSummary(noStored.detail).status,'No saved review');
  assert.equal(observeAtlasDetailResult('code_reviews_pr_summary',args,{
    ...fixtureSummary(),recordedRounds:0}),null,'count and saved-review payload conflict');
});

test('Code Reviews overview and findings count only supplied bounded facts',()=>{
  const overview=observeAtlasDetailResult('code_reviews_overview',{},
    {projectId:project,reviewRuns:47,findingObservations:28,private:'NO_LEAK'});
  assert.equal(overview?.detail?.kind,'review_overview');
  assert.deepEqual(overview?.resources.map(x=>x.type),['application','project']);
  assert.doesNotMatch(JSON.stringify(overview),/NO_LEAK/);
  assert.equal(observeAtlasDetailResult('code_reviews_overview',{},
    {projectId:runId,reviewRuns:47,findingObservations:28}),null);
  const args={reviewRunId:runId,limit:20,offset:0};
  const page={total:17,items:[
    {id:recordId,data:{reviewRunId:runId,severity:'sev3',title:'SECRET_FINDING',description:'SECRET_DESCRIPTION'}},
    {id:'6af9e4c1-659e-41df-adab-966cfdf4e849',data:{reviewRunId:runId,severity:'sev4',title:'ANOTHER_SECRET'}}]};
  const fact=observeAtlasDetailResult('code_reviews_list_findings',args,page);
  assert.equal(fact?.detail?.kind,'review_findings');
  assert.equal(fact?.detail?.kind==='review_findings'&&fact.detail.pageCount,2);
  assert.equal(fact?.detail?.kind==='review_findings'&&fact.detail.total,17);
  assert.equal(fact?.detail?.kind==='review_findings'&&fact.detail.counts.sev3,1);
  assert.equal(fact?.detail?.kind==='review_findings'&&fact.detail.counts.sev4,1);
  assert.doesNotMatch(JSON.stringify(fact),/SECRET/);
  assert.match(atlasDetailSummary(fact!.detail!).rows.join(' '),/On this page: SEV3 1 · SEV4 1/);
  assert.equal(observeAtlasDetailResult('code_reviews_list_findings',args,
    {...page,items:[{...page.items[0],data:{reviewRunId:recordId,severity:'sev3'}}]}),null);
  assert.equal(observeAtlasDetailResult('code_reviews_list_findings',args,
    {...page,total:1}),null,'inconsistent pagination is not authoritative');
});

test('successful MCP receipts produce durable task-scoped review and record views, with no body leakage',async()=>{
  const db=new Store(':memory:');db.save('conversations',{id:'conv'});
  const transport:AtlasTransport={
    list:async()=>[
      {name:'code_reviews_pr_summary',inputSchema:{type:'object',properties:{}}},
      {name:'get_record',inputSchema:{type:'object',properties:{}}}],
    close:async()=>{},
    call:async(name,args)=>{
      if(name==='code_reviews_pr_summary')return structured({...fixtureSummary(),private:'NO_LEAK'});
      if(name==='get_record')return structured({
        id:args.recordId,projectId:args.projectId,storeId:args.storeId,data:{password:'NO_LEAK'}});
      throw Error('unexpected tool');
    }
  };
  const gateway=new Gateway(db,transport,{},async()=>{});
  try{
    const tools=await gateway.tools(task('A'),new AbortController().signal);
    assert.deepEqual(tools.map(t=>t.name).sort(),['atlas_code_reviews_pr_summary','atlas_get_record']);
    await gateway.invoke(task('A'),'review','code_reviews_pr_summary',
      {repository:'affank1020/relay',prNumber:33},new AbortController().signal);
    await gateway.invoke(task('B'),'record','get_record',
      {projectId:project,storeId,recordId},new AbortController().signal);
    const events=db.events('conv');
    assert.equal(events.filter(e=>e.type==='atlas_resource').length,2);
    assert.doesNotMatch(JSON.stringify(events),/NO_LEAK|SENSITIVE_PRIVATE_MCP_PAYLOAD/);
    const details=projectAtlasDetails([...events,...events]);
    assert.equal(details.length,2);
    assert.equal(details.find(v=>v.taskId==='A')?.agentRunId,'run-A');
    assert.equal(details.find(v=>v.taskId==='A')?.detail.kind,'review_pr');
    assert.equal(details.find(v=>v.taskId==='B')?.detail.kind,'record');
    assert.deepEqual(projectAtlasDetails([]),[]);
    await gateway.invoke(task('A'),'review','code_reviews_pr_summary',
      {repository:'affank1020/relay',prNumber:33},new AbortController().signal);
    assert.equal(db.events('conv').length,events.length,'idempotent invocation replay');
  }finally{db.close();}
});

test('failed or unadvertised review tools cannot generate a trusted widget',async()=>{
  const db=new Store(':memory:');db.save('conversations',{id:'conv'});
  const transport:AtlasTransport={
    list:async()=>[],close:async()=>{},
    call:async()=>({isError:true,content:[{type:'text',text:'Atlas rejected'}]})
  };
  const gateway=new Gateway(db,transport,{},async()=>{});
  try{
    assert.deepEqual(await gateway.tools(task('A'),new AbortController().signal),[]);
    await gateway.invoke(task('A'),'error','code_reviews_overview',{},new AbortController().signal);
    assert.equal(projectAtlasDetails(db.events('conv')).length,0);
  }finally{db.close();}
});
