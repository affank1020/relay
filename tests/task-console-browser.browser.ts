import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('real Chromium preserves task output scrolling through streaming and state transitions',async()=>{
  const bundle=await build({
    entryPoints:['src/task-console.ts'],bundle:true,platform:'browser',format:'iife',
    globalName:'RelayTaskConsole',write:false,target:'es2022'
  });
  assert.ok(bundle.outputFiles?.[0]);
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:760}});
    await page.setContent('<!doctype html><html><head><style>.task-result {max-height:90px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;width:360px;font:12px monospace}</style></head><body><section id="taskConsole" hidden><div id="taskCounts"></div><select id="taskConversationFilter"></select><input id="taskSearch"><button id="taskRefresh"></button><div id="taskFeedback"></div><div id="taskRows"></div><button id="taskMore"></button><section id="taskDetail"></section></section></body></html>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(async()=>{
      const app=(window as any).RelayTaskConsole;
      const id='11111111-1111-1111-1111-111111111111';
      const conversationId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const task={
        id,conversationId,requestId:id,state:'running',prompt:'Streaming output',
        createdAt:'2026-10-31T10:00:00Z',parentId:null,dependencies:[],attemptOf:null,
        result:Array.from({length:120},(_,i)=>'Line '+i+' — '+'data '.repeat(10)).join('\n'),
        error:null,usage:[]
      };
      const approvals=[{id:'approval-1',tool:'read_only',state:'pending',args:{projectId:'safe'}}];
      (window as any).__task=task;
      const respond=(data:unknown)=>new Response(JSON.stringify(data));
      // Drive the real console's four-second scheduler without wall-clock waits.
      window.setTimeout=((fn:TimerHandler)=>{
        (window as any).__tick=fn;
        return 1;
      }) as typeof window.setTimeout;
      window.clearTimeout=(()=>{}) as typeof window.clearTimeout;
      const ui=app.mountTaskConsole(async(path:string)=>{
        if(path==='/sessions')return respond({sessions:[{id:conversationId,title:'Source'}]});
        if(path.startsWith('/task-console/tasks?'))return respond({
          tasks:[task],nextCursor:null,hasMore:false,counts:{[task.state]:1}
        });
        if(path==='/task-console/tasks/'+id)return respond({
          task,conversation:{id:conversationId,title:'Source'},children:[],approvals
        });
        if(path.startsWith('/sessions/'+conversationId+'/events?'))
          return respond({events:[],nextCursor:0,hasMore:false});
        throw new Error('Unexpected URL '+path);
      },async()=>{});
      (window as any).__ui=ui;
      await ui.show();
    });
    await page.locator('.task-row').click();
    const result=page.locator('.task-result');
    await result.waitFor();
    const start=await result.evaluate(element=>{
      element.scrollTop=420;
      element.dataset.identity='original';
      return {scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};
    });
    assert.ok(start.scrollHeight>start.clientHeight+500,'actual browser has a scrollable output box');
    assert.ok(start.scrollTop>=300,'user can scroll down');
    await page.locator('.task-approval-disclosure summary').click();
    assert.equal(await page.locator('.task-approval-disclosure').evaluate(element=>(element as HTMLDetailsElement).open),true);

    await page.evaluate(async()=>{
      const task=(window as any).__task;
      task.result+='\nAnother streamed result';
      await (window as any).__tick();
    });
    assert.equal(await result.evaluate(element=>element.dataset.identity),'original','routine output update retains element');
    assert.ok(await result.evaluate(element=>element.scrollTop)>=300);
    assert.equal(await page.locator('.task-approval-disclosure').evaluate(element=>(element as HTMLDetailsElement).open),true);

    await page.evaluate(async()=>{
      (window as any).__task.state='completed';
      await (window as any).__tick();
    });
    assert.equal(await page.locator('.task-status').textContent(),'Completed');
    const completed=await result.evaluate(element=>({
      scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,
      clientHeight:element.clientHeight,marker:element.dataset.identity
    }));
    assert.ok(completed.scrollHeight>completed.clientHeight+500);
    assert.ok(completed.scrollTop>=300,
      'Running→Completed must restore scroll after attachment to a real layout box');
    assert.equal(completed.marker,undefined,'structural update replaces container');
    await page.evaluate(()=>(window as any).__ui.hide());
  } finally {
    await browser.close();
  }
});
