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
    // tsx/esbuild injects a non-runtime __name helper into serialized
    // page.evaluate callbacks; expose its no-op equivalent in the browser.
    await page.addScriptTag({content:'var __name=(target,name)=>target;'});
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

test('real Chromium preserves inline subagent disclosure and opens the correct task after live updates',async()=>{
  const bundle=await build({entryPoints:['src/agent-progress-ui.ts'],bundle:true,platform:'browser',
    format:'iife',globalName:'RelayAgentProgress',write:false,target:'es2022'});
  assert.ok(bundle.outputFiles?.[0]);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:440,height:760}});
    await page.setContent('<!doctype html><html><body><details id="delegations"><summary></summary><div class="inline-agent-children"></div></details></body></html>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.addScriptTag({content:'var __name=(target,name)=>target;'});
    await page.evaluate(()=>{
      const app=(window as any).RelayAgentProgress;
      const first={id:'child-1',parentId:'root',agentRunId:'run-1',depth:1,role:'researcher',
        prompt:'Look for errors <script>window.hacked=true</script>',state:'running',dependencies:[],
        modelKey:null,tokens:null,costUsd:null,reportedSummary:null,lastTool:null};
      const second={...first,id:'child-2',depth:2,role:'reviewer',parentId:'child-1',state:'queued',prompt:'Review result'};
      (window as any).__agents=[first,second];
      (window as any).__opened=[];
      (window as any).__render=()=>app.renderInlineAgents(document.getElementById('delegations'),
        (window as any).__agents,(id:string)=>(window as any).__opened.push(id));
      (window as any).__render();
    });
    const group=page.locator('#delegations');
    assert.equal(await group.locator('summary').textContent(),'2 agents · 2 active');
    await group.locator('summary').click();
    const row=group.locator('[data-agent-id="child-1"]');
    assert.equal(await group.evaluate(element=>(element as HTMLDetailsElement).open),true);
    await row.evaluate(element=>{element.dataset.identity='same-node';});
    await page.evaluate(()=>{
      const agents=(window as any).__agents;
      agents[0].state='completed';
      agents[0].reportedSummary='Found evidence in the logs <img src=x onerror=alert(1)>';
      agents[1].state='failed';
      (window as any).__render();
    });
    assert.equal(await group.evaluate(element=>(element as HTMLDetailsElement).open),true);
    assert.equal(await row.evaluate(element=>element.dataset.identity),'same-node',
      'live state update must not replace the row or close disclosure');
    assert.equal(await group.locator('.inline-agent-status').first().textContent(),'Completed');
    assert.ok((await group.textContent())?.includes('Agent-reported (unverified)'));
    assert.equal(await group.locator('script, img').count(),0,'untrusted text must not become markup');
    assert.equal(await group.locator('[data-agent-id="child-2"] .inline-agent-status').textContent(),'Failed');
    await row.locator('button').click();
    assert.deepEqual(await page.evaluate(()=>(window as any).__opened),['child-1']);
    await page.evaluate(()=>{
      (window as any).__agents.splice(1,1);
      (window as any).__render();
    });
    assert.equal(await group.locator('[data-agent-id]').count(),1);
  }finally{await browser.close();}
});
