import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { CapabilityRegistry } from '../src/capabilities.js';
import { createPlatform } from '../src/platform.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';

test('real browser previews, explicitly installs, enables and revokes a pinned GitHub Skill',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-git-browser-'));
  const content='---\nname: browser-skill\ndescription: Reviewed Skill used by a real browser test.\n---\n' +
    'These instructions are untrusted until reviewed and explicitly approved.\n';
  const mockedFetch=((_:unknown)=>Promise.resolve(new Response(JSON.stringify({
    type:'file',name:'SKILL.md',encoding:'base64',
    content:Buffer.from(content).toString('base64')
  })))) as typeof fetch;
  const registry=new CapabilityRegistry(root,join(process.cwd(),'skills'),[],undefined,mockedFetch);
  const store=new Store(':memory:');
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},run:async()=>''};
  const engine=new Engine(store,harness,{concurrency:1,queue:10,sessionUsd:0,globalUsd:0,
    sessionTokens:0,reserveUsd:0,maxRunMs:1000});
  const token='t'.repeat(32);
  const server=createPlatform(engine,token,join(process.cwd(),'dist/public'),'cohere/north-mini-code:free',undefined,registry);
  const browser=await chromium.launch({headless:true});
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    page.on('dialog',dialog=>{void dialog.accept();});
    await page.goto('http://127.0.0.1:'+address.port+'/');
    await page.locator('#token').fill(token);
    await page.locator('#loginForm button').click();
    await page.locator('#openCapabilities').click();
    await page.locator('details.git-skill-installer summary').click();
    await page.locator('#gitSkillOwner').fill('example-owner');
    await page.locator('#gitSkillRepo').fill('reviewed-skills');
    await page.locator('#gitSkillCommit').fill('a'.repeat(40));
    await page.locator('#gitSkillPath').fill('SKILL.md');
    await page.locator('#gitSkillPreviewButton').click();
    await page.locator('#gitSkillReview').waitFor({state:'visible'});
    assert.equal(await page.locator('#gitSkillReviewText').textContent(),content);
    assert.match(await page.locator('#gitSkillReviewDigest').textContent()??'',/^SHA-256 [a-f0-9]{64}$/);
    assert.equal(await page.locator('#gitSkillInstall').isDisabled(),true);
    assert.equal((await registry.list()).skills.length,2,'preview does not install');
    await page.locator('#gitSkillAcknowledge').check();
    assert.equal(await page.locator('#gitSkillInstall').isEnabled(),true);
    await page.locator('#gitSkillInstall').click();
    await page.getByText('browser-skill',{exact:true}).waitFor();
    const installed=(await registry.list()).skills.find(s=>s.name==='browser-skill');
    assert.ok(installed);
    assert.equal(installed.enabled,false,'approval never enables Skill by itself');
    const enabledResponse=page.waitForResponse(response=>
      response.request().method()==='PATCH'&&response.url().endsWith('/api/capabilities/skills/'+installed.id));
    await page.getByRole('checkbox',{name:'Enable browser-skill'}).check();
    assert.equal((await enabledResponse).status(),200);
    assert.equal((await registry.list()).skills.find(s=>s.id===installed.id)?.enabled,true);
    await page.getByRole('button',{name:'Remove reviewed Skill browser-skill'}).click();
    await page.getByText('browser-skill',{exact:true}).waitFor({state:'detached'});
    assert.equal((await registry.list()).skills.some(s=>s.id===installed.id),false);
    assert.equal(await registry.skills.promptContent(),'');
    await page.close();
  }finally{
    await browser.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});
  }
});
