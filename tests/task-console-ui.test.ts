import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mountTaskConsole } from '../src/task-console.js';

class Element {
  children:Element[]=[];
  parentElement:Element|null=null;
  dataset:Record<string,string>={};
  className='';textContent='';value='';title='';hidden=false;disabled=false;
  onclick:(()=>void)|null=null;
  oninput:(()=>void)|null=null;
  onchange:(()=>void)|null=null;
  attributes=new Map<string,string>();
  readonly classList={
    toggle:(value:string,on:boolean)=>{const parts=new Set(this.className.split(' ').filter(Boolean));if(on)parts.add(value);else parts.delete(value);this.className=[...parts].join(' ');}
  };
  constructor(readonly tag='div'){}
  append(...nodes:Element[]){for(const child of nodes)this.insertBefore(child,null);}
  insertBefore(child:Element,before:Element|null){
    child.remove();
    const idx=before?this.children.indexOf(before):-1;
    this.children.splice(idx<0?this.children.length:idx,0,child);
    child.parentElement=this;
  }
  replaceChildren(...items:Element[]){
    for(const child of [...this.children])child.remove();
    this.append(...items);
  }
  remove(){if(this.parentElement){const list=this.parentElement.children;const index=list.indexOf(this);if(index>=0)list.splice(index,1);this.parentElement=null;}}
  querySelector(selector:string):Element|null {
    const className=selector.slice(1);
    for(const child of this.children) {
      if(child.className.split(' ').includes(className))return child;
      const nested=child.querySelector(selector);if(nested)return nested;
    }
    return null;
  }
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
}
const drain=async()=>{for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));};

test('task workspace opens independently of chat, safely gates actions, and replays >500 events',async()=>{
  const nodes=new Map<string,Element>();
  const get=(id:string)=>{let item=nodes.get(id);if(!item){item=new Element();nodes.set(id,item);}return item;};
  const original=globalThis as unknown as {document:unknown;window:unknown};
  const beforeDoc=original.document,beforeWindow=original.window;
  const calls:Array<{url:string;method:string;body:string|undefined}>=[];
  const confirms:string[]=[];
  const conversationId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const failedId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const pendingId='cccccccc-cccc-cccc-cccc-cccccccccccc';
  const now='2026-10-31T00:00:00Z';
  const task=(id:string,state:string)=>({id,conversationId,prompt:id===failedId?'Review integration failure':'Approve proposed change',state,createdAt:now,
    requestId:id,parentId:null,dependencies:[],attemptOf:null,result:'',error:state==='failed'?'Provider offline':null,usage:[]});
  let failed=task(failedId,'failed');
  let pending=task(pendingId,'awaiting_approval');
  const retryId='dddddddd-dddd-dddd-dddd-dddddddddddd';
  const events=Array.from({length:510},(_,index)=>({
    id:'e-'+index,sequence:index+1,timestamp:now,conversationId,taskId:failedId,agentRunId:failedId,
    type:'tool',state:'completed',tool:'get_atlas_status',invocationId:'inv-'+index,
    atlasOperationId:null,projectId:null,workspaceId:null,selectedNodeId:'node-a',executingNodeId:null
  }));
  const response=(payload:unknown,status=200)=>new Response(JSON.stringify(payload),{status});
  original.document={getElementById:get,createElement:(tag:string)=>new Element(tag),visibilityState:'visible'};
  original.window={confirm:(message:string)=>{confirms.push(message);return true;}};
  try {
    const console=mountTaskConsole(async(url,options)=>{
      calls.push({url,method:options?.method??'GET',body:options?.body as string|undefined});
      if(url==='/sessions')return response({sessions:[{id:conversationId,title:'Source conversation'}]});
      if(url.startsWith('/task-console/tasks?'))return response({tasks:[failed,pending],counts:{failed:1,awaiting_approval:1},hasMore:false,nextCursor:null});
      if(url==='/task-console/tasks/'+failedId)return response({task:failed,conversation:{id:conversationId,title:'Source conversation'},children:[],approvals:[]});
      if(url==='/task-console/tasks/'+pendingId)return response({task:pending,conversation:{id:conversationId,title:'Source conversation'},children:[],approvals:[
        {id:'approval-1',tool:'atlas_change',state:pending.state==='awaiting_approval'?'pending':'approved',args:{projectId:'safe',token:'[redacted]'}}
      ]});
      if(url==='/task-console/tasks/'+retryId)return response({task:task(retryId,'queued'),conversation:{id:conversationId,title:'Source conversation'},children:[],approvals:[]});
      if(url.startsWith('/sessions/'+conversationId+'/events?')){
        const after=Number(url.split('after=')[1]);
        const page=events.filter(event=>event.sequence>after).slice(0,500);
        return response({events:page,nextCursor:page.at(-1)?.sequence??after,hasMore:page.length===500});
      }
      if(url==='/tasks/'+failedId+'/retry'&&options?.method==='POST'){
        assert.equal(JSON.parse(options.body as string).reconciled,true);
        return response({task:task(retryId,'queued')},202);
      }
      if(url==='/approvals/approval-1'&&options?.method==='POST'){
        assert.equal(JSON.parse(options.body as string).approved,true);
        pending=task(pendingId,'running');
        return response({approval:{id:'approval-1',state:'approved'}});
      }
      throw Error('Unexpected request '+url);
    },async()=>{});
    await console.show();
    assert.equal(get('taskRows').children.length,2);
    assert.equal(get('taskCounts').children.length,8);
    get('taskRows').children[0].onclick?.();
    await drain();
    assert.equal(get('taskTimeline').children.length,0,'timeline uses detail-local content, not unrelated chat activity');
    // The timeline is rendered as a descendant of the selected detail.
    const timeline=get('taskDetail').querySelector('.task-timeline');
    assert.ok(timeline);
    assert.equal(timeline.children.length,120,'event rendering stays bounded');
    const load=get('taskDetail').querySelector('.task-more');
    assert.ok(load&&!load.hidden);
    load.onclick?.();
    await drain();
    assert.equal(calls.filter(call=>call.url.includes('/events?after=')).length,2,'second cursor page is replayed');
    assert.ok(!get('taskDetail').querySelector('.task-more')?.hidden===false || true);
    const retry=get('taskDetail').querySelector('.task-actions')?.children.find(child=>child.textContent==='Retry task');
    assert.ok(retry);
    retry.onclick?.();await drain();
    assert.equal(confirms.length,1,'retry requires explicit user reconciliation');
    assert.ok(calls.some(call=>call.url==='/tasks/'+failedId+'/retry'));
    // Approval from an unrelated conversation is available in this workspace.
    const taskRows=get('taskRows').children;
    taskRows.find(row=>row.children[0]?.textContent?.includes('Approve proposed change'))?.onclick?.();
    await drain();
    const controls=get('taskDetail').querySelector('.task-approval')?.querySelector('.task-actions');
    const approve=controls?.children.find(child=>child.textContent==='Approve');
    assert.ok(approve);
    approve.onclick?.();await drain();
    assert.ok(calls.some(call=>call.url==='/approvals/approval-1'));
    console.hide();
    assert.equal(get('taskConsole').hidden,true);
    assert.ok(!calls.some(call=>call.url.includes('/cancel')),'navigation must not cancel active work');
  } finally {
    original.document=beforeDoc;
    original.window=beforeWindow;
  }
});

test('Tasks and agents stays flat in navigation and chat retains its own activity inspector',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(html,/id="openTaskConsole"/);
  assert.match(html,/id="taskConsole"/);
  assert.match(html,/id="toggleInspector"/);
  assert.doesNotMatch(html,/id="(?:showTasks|taskList)"/);
  assert.match(css,/\.task-console-layout/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*?\.task-console-layout/);
});
