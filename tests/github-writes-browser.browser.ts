import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { CapabilityRegistry } from '../src/capabilities.js';
import { configuredProviders } from '../src/integrations/manager.js';
import { Engine } from '../src/engine.js';
import { Store, type Approval } from '../src/store.js';
import { createPlatform } from '../src/platform.js';
import type { HarnessRequest } from '../src/harness.js';

test('real browser shows exact GitHub write details and waits for explicit approval',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-github-write-browser-'));
  const store=new Store(':memory:');
  const provider=configuredProviders({RELAY_GITHUB_TOKEN:'redacted',
    RELAY_GITHUB_WRITE_REPOS:'example/repo'})[0];
  const args={owner:'example',repo:'repo',issue_number:123,
    body:'Review this exact body before posting'};
  const schema={type:'object',properties:{
    owner:{type:'string'},repo:{type:'string'},issue_number:{type:'integer'},body:{type:'string'}
  },required:['owner','repo','issue_number','body'],additionalProperties:false};
  let calls=0;
  const registry=new CapabilityRegistry(root,join(process.cwd(),'skills'),[provider]);
  await registry.update('integrations','github',true);
  const harness={version:1 as const,capabilities:{persistence:true,cancellation:true,tools:true},
    deleteConversationSessions:async()=>{},
    run:async(req:HarnessRequest)=>{
      assert.ok(req.nativeMcp?.approve);
      await req.nativeMcp.approve(req.task,'ui-approval-call','github:add_issue_comment',args,req.signal);
      calls++;
      return 'posted';
    }};
  const engine=new Engine(store,harness,{concurrency:1,queue:8,sessionUsd:0,
    globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:10000},
    undefined,{},undefined,registry);
  const token='x'.repeat(32);
  const server=createPlatform(engine,token,join(process.cwd(),'dist/public'),
    'cohere/north-mini-code:free',undefined,registry);
  // Start a known persisted session before browser login. This verifies that
  // a pending mutation is discoverable after reconnect, not merely a
  // transient view created during a chat send.
  const chat=engine.conversation();
  const job=engine.enqueue(chat.id,'Post the exact GitHub issue comment','browser-write');
  const until=Date.now()+5000;
  while(!store.all<Approval>('approvals').some(a=>a.taskId===job.id&&a.state==='pending')){
    if(Date.now()>until)throw new Error('GitHub approval was never requested');
    await new Promise(resolve=>setTimeout(resolve,15));
  }
  const browser=await chromium.launch({headless:true});
  try{
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.goto('http://127.0.0.1:'+address.port+'/');
    await page.locator('#token').fill(token);
    await page.locator('#loginForm button').click();
    const panel=page.locator('#approvals .approval');
    await panel.waitFor({state:'visible',timeout:10000});
    assert.equal(calls,0);
    assert.match(await panel.textContent()??'',/GitHub write: review the exact repository/);
    assert.match(await panel.locator('pre').textContent()??'',/"issue_number": 123/);
    assert.match(await panel.locator('pre').textContent()??'',/Review this exact body before posting/);
    assert.match(await panel.locator('pre').textContent()??'',/"repo": "repo"/);
    assert.doesNotMatch(await panel.textContent()??'',/redacted/);
    assert.ok(store.all<Approval>('approvals').some(a=>a.state==='pending'));
    await panel.getByRole('button',{name:'Approve action'}).click();
    await page.getByText('posted',{exact:true}).waitFor({state:'visible'});
    assert.equal(calls,1);
    assert.deepEqual(store.all<Approval>('approvals').map(a=>a.state),['approved']);
    await page.close();
  }finally{
    await browser.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await engine.stop();store.close();await registry.close();await rm(root,{recursive:true,force:true});
  }
});
