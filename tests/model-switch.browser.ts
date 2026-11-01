import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createPlatform } from '../src/platform.js';

test('real browser switches the existing chat model and restores rejected selection',async()=>{
  const store=new Store(':memory:');
  const registry={defaultKey:'openrouter/a:free',models:['a:free','b:free'].map(id=>({id,key:'openrouter/'+id,provider:'openrouter' as const,label:id}))};
  const engine=new Engine(store,{version:1,capabilities:{persistence:true,cancellation:true,tools:true},run:async()=>''},
    {concurrency:1,queue:4,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000},undefined,{},registry);
  const chat=engine.conversation();
  const server=createPlatform(engine,'x'.repeat(32),join(process.cwd(),'dist/public'),'a:free',registry);
  const browser=await chromium.launch({headless:true});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    await page.locator('#token').fill('x'.repeat(32));await page.locator('#loginForm button').click();
    await page.locator('#modelPicker option[value="openrouter/a:free"]').waitFor({state:'attached'});
    await page.locator('#modelPicker').selectOption('openrouter/b:free');
    await page.waitForResponse(response=>response.url().endsWith('/api/sessions')&&response.status()===200);
    assert.equal(store.get<{modelKey:string}>('conversations',chat.id)?.modelKey,'openrouter/b:free');
    assert.equal(store.all('conversations').length,1);
    await page.route('**/api/sessions/'+chat.id,async route=>{
      if(route.request().method()==='PATCH')await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Conversation has an active task'})});
      else await route.continue();
    });
    await page.locator('#modelPicker').selectOption('openrouter/a:free');
    await page.getByText('Conversation has an active task',{exact:true}).waitFor();
    await page.waitForFunction(()=> (document.getElementById('modelPicker') as HTMLSelectElement).value==='openrouter/b:free');
    assert.equal(store.all('conversations').length,1);
  }finally{await browser.close();await engine.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
