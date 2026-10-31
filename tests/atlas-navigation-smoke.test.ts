import assert from 'node:assert/strict';
import {test} from 'node:test';
import {atlasCheckoutLink,atlasDetailLink,atlasNodeLink,parseAtlasWebOrigin} from '../src/atlas-navigation.js';
import {verifyAtlasReadOnlyConnection} from '../src/atlas-smoke.js';
import type {AtlasTransport} from '../src/gateway.js';
import type {AtlasDetail} from '../src/atlas-awareness-details.js';

const project='008b191b-96c2-4a5f-92f6-1f13d6d790d5';
const store='0140b619-4f75-454e-92a3-c8b595c9dee5';
const record='1fd91155-6511-4ca1-8079-8568fea4c1eb';
const origin='https://atlas.example.com';

test('Atlas navigation accepts only operator-supplied HTTPS or local development origins',()=>{
  assert.equal(parseAtlasWebOrigin(origin),origin);
  assert.equal(parseAtlasWebOrigin('https://atlas.example.com:443'),origin);
  assert.equal(parseAtlasWebOrigin('http://localhost:3100'),'http://localhost:3100');
  assert.equal(parseAtlasWebOrigin('http://127.0.0.1:3100'),'http://127.0.0.1:3100');
  assert.equal(parseAtlasWebOrigin(undefined),undefined);
  assert.equal(parseAtlasWebOrigin(''),undefined);
  for(const invalid of [
    'http://atlas.example.com','https://user:password@atlas.example.com',
    'https://atlas.example.com/projects','https://atlas.example.com/?private=1',
    'https://atlas.example.com/#/projects','ftp://atlas.example.com',
    '//atlas.example.com','javascript:alert(1)','https://atlas.example.com\n',
    ' https://atlas.example.com','https://atlas.example.com/extra/..',
  ])assert.throws(()=>parseAtlasWebOrigin(invalid),/ATLAS_WEB_ORIGIN/,invalid);
});

test('navigation uses verified Atlas Web routes, never imaginary record or checkout routes',()=>{
  const projectDetail:AtlasDetail={kind:'project',projectId:project};
  const storeDetail:AtlasDetail={kind:'store',projectId:project,storeId:store};
  const recordDetail:AtlasDetail={kind:'record',projectId:project,storeId:store,recordId:record};
  const overview:AtlasDetail={kind:'review_overview',projectId:project,reviewRuns:3,findingObservations:2};
  assert.deepEqual(atlasDetailLink(origin,projectDetail),{
    href:origin+'/#/projects/'+project,label:'Open project'});
  assert.deepEqual(atlasDetailLink(origin,storeDetail),{
    href:origin+'/#/projects/'+project+'/stores/'+store+'/records',label:'Open store'});
  assert.deepEqual(atlasDetailLink(origin,recordDetail),{
    href:origin+'/#/projects/'+project+'/stores/'+store+'/records',label:'Open containing store'});
  assert.deepEqual(atlasDetailLink(origin,overview),{
    href:origin+'/#/applications/code-reviews',label:'Open Code Reviews'});
  assert.deepEqual(atlasCheckoutLink(origin,{checkoutId:record,projectId:project}),{
    href:origin+'/#/projects/'+project+'/workspaces',label:'Open project workspaces'});
  assert.deepEqual(atlasCheckoutLink(origin,{checkoutId:record}),{
    href:origin+'/#/workspaces',label:'Open workspaces'});
  assert.deepEqual(atlasNodeLink(origin,project),{
    href:origin+'/#/nodes',label:'Open Nodes'});
  assert.equal(atlasDetailLink(undefined,recordDetail),undefined);
  assert.equal(atlasDetailLink('https://example.com/#bad',recordDetail),undefined);
  assert.equal(atlasDetailLink(origin,{kind:'project',projectId:'javascript:alert(1)'}),undefined);
  assert.equal(atlasNodeLink(origin,'bad'),undefined);
  assert.equal(atlasCheckoutLink(origin,{checkoutId:'../invalid'}),undefined);
  assert.equal(atlasCheckoutLink(origin,{checkoutId:record,projectId:'bad'})?.href,origin+'/#/workspaces');
});

// Matches the actual Atlas CoreService.status() structured MCP response.
const atlasStatus=()=>({
  product:'Atlas',version:'2.0.0',storage:'postgresql',schemaVersion:1,
  projects:12,stores:45,records:1207,views:5,
  counts:{
    projects:{total:16,active:12,archived:4},
    stores:{total:57,active:45,archived:12},
    records:{total:1258,active:1207,archived:51},
    views:{total:5,active:5,archived:0}
  },
  subsystems:{views:{status:'available',stage:3}}
});
const result=(obj:unknown)=>({structuredContent:{result:obj},
  content:[{type:'text',text:'secret_private_payload'}]});
function fake(tools:string[],output:Record<string,unknown>,calls:string[]):Pick<AtlasTransport,'list'|'call'> {
  return {list:async()=>tools.map(name=>({name,inputSchema:{}})),
    call:async(name)=>{
      calls.push(name);
      if(name==='get_atlas_status')return result(output.status??atlasStatus());
      if(name==='get_project')return result(output.project??{id:project,name:'Private project',data:{password:'secret'}});
      if(name==='code_reviews_overview')return result(output.reviews??{
        projectId:project,reviewRuns:8,findingObservations:19,private:'not_exposed'});
      throw Error('unexpected tool '+name);
    }};
}

test('credentialed smoke contract reads only allowlisted, discovered tools and returns no sensitive data',async()=>{
  const calls:string[]=[];
  const t=fake(['get_atlas_status','get_project','code_reviews_overview','create_project'],{},calls);
  const report=await verifyAtlasReadOnlyConnection(t,{projectId:project});
  assert.deepEqual(calls,['get_atlas_status','get_project','code_reviews_overview']);
  assert.deepEqual(report,{discoveredTools:4,allowedReadTools:3,coreStatus:'verified',
    codeReviews:'verified',projectRead:'verified'});
  assert.doesNotMatch(JSON.stringify(report),/Private|secret|not_exposed|password/);
});

test('absence of Code Reviews permission is not misreported as success',async()=>{
  const calls:string[]=[];
  const report=await verifyAtlasReadOnlyConnection(fake(['get_atlas_status','create_project'],{},calls));
  assert.deepEqual(calls,['get_atlas_status']);
  assert.equal(report.codeReviews,'not_advertised');
  assert.equal(report.projectRead,'not_requested');
  const missingProject=await verifyAtlasReadOnlyConnection(
    fake(['get_atlas_status'],{},[]),{projectId:project});
  assert.equal(missingProject.projectRead,'not_advertised');
});

test('operator smoke requires the real Atlas status contract rather than any nonempty object',async()=>{
  const valid=await verifyAtlasReadOnlyConnection(fake(['get_atlas_status'],{status:atlasStatus()},[]));
  assert.equal(valid.coreStatus,'verified');
  const known=atlasStatus();
  const invalid=[
    {success:false,error:'backend unavailable'},
    {name:'Atlas',connected:true},
    {...known,product:'unrelated'},
    {...known,version:'not-semver'},
    {...known,schemaVersion:0},
    {...known,projects:-1},
    {...known,stores:2.5},
    {...known,counts:{...known.counts,projects:{total:10,active:12,archived:4}}},
    {...known,counts:{...known.counts,records:{total:1258,active:0,archived:51}}},
    {...known,counts:undefined}
  ];
  for(const status of invalid){
    await assert.rejects(
      verifyAtlasReadOnlyConnection(fake(['get_atlas_status'],{status},[])),
      /Atlas status contract mismatch|Atlas read-only operation failed/,
      'invalid status must never be reported as verified');
  }
});

test('failure flags in MCP response envelopes cannot be bypassed by a valid nested status',async()=>{
  const catalogue=async()=>[{name:'get_atlas_status',inputSchema:{}}];
  for(const response of [
    {success:false,structuredContent:{result:atlasStatus()}},
    {structuredContent:{success:false,result:atlasStatus()}},
    {structuredContent:{result:{...atlasStatus(),success:false}}},
  ]){
    const transport:Pick<AtlasTransport,'list'|'call'>={list:catalogue,call:async()=>response};
    await assert.rejects(verifyAtlasReadOnlyConnection(transport),/Atlas read-only operation failed/);
  }
});

test('smoke rejects duplicate catalogue entries, malformed identities and denied receipts',async()=>{
  await assert.rejects(verifyAtlasReadOnlyConnection(fake(['get_atlas_status','get_atlas_status'],{},[])),
    /Duplicate Atlas tool/);
  await assert.rejects(verifyAtlasReadOnlyConnection(fake(['get_project'],{},[])),
    /Required Atlas read/);
  await assert.rejects(verifyAtlasReadOnlyConnection(fake(['get_atlas_status','get_project'],{
    project:{id:'bad',name:'Wrong'}},[]),{projectId:project}),/identity did not match/);
  await assert.rejects(verifyAtlasReadOnlyConnection(fake(['get_atlas_status','code_reviews_overview'],{
    reviews:{projectId:'bad',reviewRuns:8,findingObservations:19}},[])),/did not match/);
  await assert.rejects(verifyAtlasReadOnlyConnection(fake(['get_atlas_status'],{},[]),
    {projectId:'not-a-uuid'}),/Invalid optional/);
  const failure:Pick<AtlasTransport,'list'|'call'>={
    list:async()=>[{name:'get_atlas_status',inputSchema:{}}],
    call:async()=>({isError:true,structuredContent:{result:{name:'false success'}}})};
  await assert.rejects(verifyAtlasReadOnlyConnection(failure),/operation failed/);
});
