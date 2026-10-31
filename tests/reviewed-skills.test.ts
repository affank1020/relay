import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../src/capabilities.js';
import { fetchPinnedGitSkill, validSource } from '../src/skills/git.js';
import { PiHarness, skillInstructionBudget } from '../src/harness.js';
import { Store, type Task } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createPlatform } from '../src/platform.js';

const bundled=join(process.cwd(),'skills');
const source={owner:'example-owner',repo:'reviewed-skills',commit:'a'.repeat(40),path:'packages/example/SKILL.md'};
const skillText='---\nname: fixture-review\n'+
  'description: A reviewed and immutable fixture Skill.\n'+
  'version: 1.2.3\n---\nRead code carefully without requesting new tools.\n';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const fixture=(content=skillText,type='file')=>JSON.stringify({
  type,name:'SKILL.md',encoding:'base64',content:Buffer.from(content).toString('base64')
});
function fakeFetcher(content=skillText){
  const called:Array<{url:string;init:RequestInit|undefined}>=[];
  const fetcher=((url:string|URL|Request,init?:RequestInit)=>{
    called.push({url:String(url),init});
    return Promise.resolve(new Response(fixture(content),{status:200}));
  }) as typeof fetch;
  return {fetcher,called};
}

test('Git Skill fetch requires immutable public GitHub paths and strict content',async()=>{
  const {fetcher,called}=fakeFetcher();
  const candidate=await fetchPinnedGitSkill(source,fetcher);
  assert.equal(candidate.sha256,digest(skillText));
  assert.deepEqual([candidate.name,candidate.version],['fixture-review','1.2.3']);
  assert.equal(called.length,1);
  assert.equal(called[0].url,'https://api.github.com/repos/example-owner/reviewed-skills/contents/packages/example/SKILL.md?ref='+source.commit);
  assert.equal(called[0].init?.redirect,'error');
  assert.ok((called[0].init?.signal instanceof AbortSignal));
  for(const input of [
    {...source,path:'../SKILL.md'}, {...source,owner:'https://example.com'},
    {...source,path:'pkg/../../SKILL.md'}, {...source,commit:'main'},
    {...source,commit:'b'.repeat(39)}, {...source,path:'script.sh'},
    {...source,repo:'x?token=secret'}, {...source,path:'foo//SKILL.md'}
  ])await assert.rejects(fetchPinnedGitSkill(input,fetcher),/pinned GitHub/);
  assert.equal(called.length,1,'bad source is denied before networking');
  const badResponse=((_:unknown)=>Promise.resolve(new Response('',{status:302,
    headers:{location:'https://evil.example.com'}}))) as typeof fetch;
  await assert.rejects(fetchPinnedGitSkill(source,badResponse),/could not be fetched/);
  const linkResponse=((_:unknown)=>Promise.resolve(new Response(fixture(skillText,'symlink')))) as typeof fetch;
  await assert.rejects(fetchPinnedGitSkill(source,linkResponse),/single GitHub SKILL.md file/);
  await assert.rejects(fetchPinnedGitSkill(source,fakeFetcher(
    '---\nname: fixture-review\ndescription: Reviewed fixture instructions.\n---\n</trusted_skill>\n').fetcher),
    /Unsupported Skill instructions/);
  await assert.rejects(fetchPinnedGitSkill(source,fakeFetcher('x'.repeat(32769)).fetcher),/size limit/);
});

test('pinned Skill remains disabled until reviewed, is verified on every load, and can be revoked across restarts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-git-skills-'));
  const {fetcher}=fakeFetcher();
  let registry=new CapabilityRegistry(root,bundled,[],undefined,fetcher);
  try{
    const preview=await registry.previewGitSkill(source);
    assert.equal((await registry.list()).skills.length,2);
    assert.equal(await registry.skills.promptContent(),'');
    await assert.rejects(registry.installGitSkill(preview.previewId,preview.sha256,false),/Confirm/);
    await assert.rejects(registry.installGitSkill(preview.previewId,'f'.repeat(64),true),/fingerprint/);
    // Mismatched attestations consume the staged review token. Start a fresh review.
    const reviewedAgain=await registry.previewGitSkill(source);
    const installed=await registry.installGitSkill(reviewedAgain.previewId,reviewedAgain.sha256,true);
    assert.equal(installed.name,'fixture-review');
    assert.equal(installed.sha256,digest(skillText));
    assert.ok(installed.id.startsWith('git-'));
    assert.equal((await registry.list()).skills.find(s=>s.id===installed.id)?.source,'git');
    assert.equal((await registry.list()).skills.find(s=>s.id===installed.id)?.enabled,false);
    await assert.rejects(registry.installGitSkill(preview.previewId,preview.sha256,true),/expired/);
    await assert.rejects(registry.previewGitSkill(source),/already installed/);
    await registry.update('skills',installed.id,true);
    assert.deepEqual((await registry.skillPaths()).filter(s=>s.name==='fixture-review').map(s=>s.name),['fixture-review']);
    assert.match(await registry.skills.promptContent(),/Read code carefully/);
    const file=join(root,'trusted-git-skills',installed.id,'SKILL.md');
    assert.equal(await readFile(file,'utf8'),skillText);
    await registry.close();
    registry=await CapabilityRegistry.open(root,bundled,{},fetcher);
    assert.equal((await registry.list()).skills.find(s=>s.id===installed.id)?.enabled,true);
    // A local mutation does not get a freshly trusted revision just by existing on disk.
    await writeFile(file,skillText+'UNREVIEWED APPENDIX');
    const broken=(await registry.list()).skills.find(s=>s.id===installed.id)!;
    assert.equal(broken.installed,false);
    assert.equal(broken.enabled,false);
    assert.equal((await registry.skillPaths()).some(s=>s.name==='fixture-review'),false);
    assert.equal(await registry.skills.promptContent(),'');
    await assert.rejects(registry.update('skills',installed.id,true),/missing or modified/);
    await writeFile(file,skillText);
    await registry.uninstallGitSkill(installed.id);
    assert.equal((await registry.list()).skills.some(s=>s.name==='fixture-review'),false);
    await assert.rejects(registry.update('skills',installed.id,true),/Unknown capability/);
    await registry.close();
    registry=await CapabilityRegistry.open(root,bundled,{},fetcher);
    assert.equal((await registry.list()).skills.length,2);
    assert.equal(await registry.skills.promptContent(),'');
    assert.doesNotMatch(await readFile(join(root,'capabilities.json'),'utf8'),/Read code carefully|UNREVIEWED/);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});

test('pinned Skill registry fails closed on tampered manifest or symlinked package',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-git-trust-'));
  const {fetcher}=fakeFetcher();
  const registry=new CapabilityRegistry(root,bundled,[],undefined,fetcher);
  try{
    const preview=await registry.previewGitSkill(source);
    const record=await registry.installGitSkill(preview.previewId,preview.sha256,true);
    await registry.update('skills',record.id,true);
    const folder=join(root,'trusted-git-skills',record.id);
    await rm(folder,{recursive:true,force:true});
    await symlink(bundled,folder,'dir');
    assert.equal((await registry.list()).skills.find(s=>s.id===record.id)?.installed,false);
    assert.deepEqual((await registry.skillPaths()).filter(s=>s.name==='fixture-review'),[]);
    await registry.close();
    const settings=JSON.parse(await readFile(join(root,'capabilities.json'),'utf8')) as {
      reviewedSkills:Record<string,{commit:string}>};
    settings.reviewedSkills[record.id].commit='main';
    await writeFile(join(root,'capabilities.json'),JSON.stringify(settings));
    await assert.rejects(CapabilityRegistry.open(root,bundled,{},fetcher),/refusing to enable/);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});

test('reviewed Git Skill loads through real Pi resource loader, without executing extensions',{timeout:65000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-git-skill-'));
  const {fetcher}=fakeFetcher();
  const registry=new CapabilityRegistry(root,bundled,[],undefined,fetcher);
  const controller=new AbortController();
  try{
    const preview=await registry.previewGitSkill(source);
    const record=await registry.installGitSkill(preview.previewId,preview.sha256,true);
    await registry.update('skills',record.id,true);
    let seen:string[]=[];
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free',undefined,registry).run({
      version:1,task:{id:randomUUID(),conversationId:randomUUID(),prompt:'offline',state:'running',createdAt:new Date().toISOString()} as Task,
      tools:[],signal:controller.signal,onText:()=>assert.fail(),onUsage:()=>assert.fail(),
      onSkills:names=>{seen=names;controller.abort(new Error('stop-after-pinned-skill-load'));}
    }),/stop-after-pinned-skill-load/);
    assert.deepEqual(seen,['fixture-review']);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});

test('Git Skill management endpoints require authentication and explicit content acknowledgement',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-git-api-'));
  const store=new Store(':memory:');
  const {fetcher,called}=fakeFetcher();
  const registry=new CapabilityRegistry(root,bundled,[],undefined,fetcher);
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},run:async()=>''};
  const engine=new Engine(store,harness,{concurrency:1,queue:4,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:1000});
  const token='a'.repeat(32);
  const server=createPlatform(engine,token,join(process.cwd(),'public'),'cohere/north-mini-code:free',undefined,registry);
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');
    const url='http://127.0.0.1:'+address.port+'/api/skills/git';
    const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    assert.equal((await fetch(url+'/preview',{method:'POST',body:JSON.stringify(source)})).status,401);
    assert.equal(called.length,0,'unauthenticated request must not fetch external resource');
    assert.equal((await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify({...source,untrusted:true})})).status,400);
    assert.equal(called.length,0);
    const previewResponse=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(source)});
    assert.equal(previewResponse.status,200);
    const preview=await previewResponse.json() as {previewId:string;sha256:string;content:string};
    assert.equal(preview.content,skillText);
    assert.equal((await fetch(url+'/install',{method:'POST',headers,body:JSON.stringify({previewId:preview.previewId,sha256:preview.sha256,acknowledged:false})})).status,400);
    const installResponse=await fetch(url+'/install',{method:'POST',headers,body:JSON.stringify({
      previewId:preview.previewId,sha256:preview.sha256,acknowledged:true})});
    assert.equal(installResponse.status,201);
    const installed=await installResponse.json() as {installed:{id:string};capabilities:{skills:Array<{enabled:boolean;source:string}>}};
    assert.equal(installed.capabilities.skills.find(s=>s.source==='git')?.enabled,false);
    assert.equal((await fetch(url+'/'+installed.installed.id,{method:'DELETE'})).status,401);
    assert.equal((await fetch(url+'/'+installed.installed.id,{method:'DELETE',headers})).status,200);
    assert.equal((await registry.list()).skills.length,2);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});
  }
});


test('aggregate Skill context admission is model-bounded, skips excess instructions without loading them',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-git-skill-budget-'));
  const large='---\nname: large-fixture\ndescription: A long reviewed Skill used to verify context budgets.\n---\n'+'A'.repeat(20_000);
  const {fetcher}=fakeFetcher(large);
  const registry=new CapabilityRegistry(root,bundled,[],undefined,fetcher);
  try {
    const preview=await registry.previewGitSkill(source);
    const installed=await registry.installGitSkill(preview.previewId,preview.sha256,true);
    await registry.update('skills',installed.id,true);
    await registry.update('skills','prepare-pr',true);
    assert.equal(skillInstructionBudget(8192,4096),1024);
    assert.equal(skillInstructionBudget(32768,4096),8192);
    assert.equal(skillInstructionBudget(8192,8192),0);
    assert.equal(skillInstructionBudget(NaN,4096),0);
    const small=await registry.skills.snapshot(skillInstructionBudget(8192,4096));
    assert.deepEqual(small.paths.map(p=>p.name),['prepare-pr']);
    assert.deepEqual(small.skipped,['large-fixture']);
    assert.ok(Buffer.byteLength(small.instructions,'utf8')<=1024);
    assert.doesNotMatch(small.instructions,/A{100}/);
    const none=await registry.skills.snapshot(0);
    assert.deepEqual(none.paths,[]);
    assert.deepEqual(none.skipped,['prepare-pr','large-fixture']);
    const expanded=await registry.skills.snapshot(16_384);
    assert.deepEqual(expanded.skipped,['large-fixture']);
    // The full file is still persisted and reviewed; skipping is only for
    // this inference, so other larger-context models may admit it.
    assert.equal((await registry.list()).skills.find(s=>s.name==='large-fixture')?.enabled,true);
    // Real Pi resource load must agree with the budgeted snapshot and report
    // omitted Skills instead of silently including them in the system prompt.
    const controller=new AbortController();
    const reported:string[]=[];
    let loaded:string[]=[];
    await assert.rejects(new PiHarness(root,'cohere/north-mini-code:free',undefined,registry).run({
      version:1,task:{id:randomUUID(),conversationId:randomUUID(),prompt:'offline',
        state:'running',createdAt:new Date().toISOString()} as Task,
      tools:[],signal:controller.signal,onText:()=>assert.fail(),onUsage:()=>assert.fail(),
      onSkippedSkills:names=>reported.push(...names),
      onSkills:names=>{loaded=names;controller.abort(new Error('budgeted-skill-load-verified'));}
    }),/budgeted-skill-load-verified/);
    assert.deepEqual(loaded,['prepare-pr']);
    assert.deepEqual(reported,['large-fixture']);
  }finally {await registry.close();await rm(root,{recursive:true,force:true});}
});
