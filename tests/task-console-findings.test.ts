import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountTaskConsole } from '../src/task-console.js';

class Element {
  readonly children:Element[]=[];
  parentElement:Element|null=null;
  dataset:Record<string,string>={};
  className='';textContent='';value='';title='';hidden=false;disabled=false;
  onclick:(()=>void)|null=null;
  onchange:(()=>void)|null=null;
  oninput:(()=>void)|null=null;
  attributes=new Map<string,string>();
  readonly classList={
    toggle:(name:string,enabled:boolean)=>{
      const names=new Set(this.className.split(' ').filter(Boolean));
      if(enabled)names.add(name);else names.delete(name);
      this.className=[...names].join(' ');
    }
  };
  constructor(readonly tag='div'){}
  append(...items:Element[]){for(const item of items)this.insertBefore(item,null);}
  insertBefore(item:Element,before:Element|null){
    item.remove();
    const index=before?this.children.indexOf(before):-1;
    this.children.splice(index<0?this.children.length:index,0,item);
    item.parentElement=this;
  }
  replaceChildren(...items:Element[]){for(const item of [...this.children])item.remove();this.append(...items);}
  remove(){
    if(!this.parentElement)return;
    const children=this.parentElement.children;
    const index=children.indexOf(this);
    if(index>=0)children.splice(index,1);
    this.parentElement=null;
  }
  querySelector(selector:string):Element|null {
    const name=selector.slice(1);
    for(const item of this.children){
      if(item.className.split(' ').includes(name))return item;
      const match=item.querySelector(selector);
      if(match)return match;
    }
    return null;
  }
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
}
const flush=async()=>{for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
const response=(data:unknown)=>new Response(JSON.stringify(data));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const one='11111111-1111-1111-1111-111111111111';
const two='22222222-2222-2222-2222-222222222222';
const when='2026-10-31T10:00:00Z';
const task=(id:string,conversationId:string,state:string,result='')=>({
  id,conversationId,state,prompt:'Work '+id,createdAt:when,requestId:id,
  parentId:null,dependencies:[],attemptOf:null,result,error:null,usage:[]
});
const sessions=[
  {id:A,title:'Conversation A',modelKey:'openrouter/test'},
  {id:B,title:'Conversation B',modelKey:'openrouter/test'}
];

async function fixture(run:(get:(id:string)=>Element,ui:ReturnType<typeof mountTaskConsole>,calls:string[])=>Promise<void>,
  responder:(url:string,options?:RequestInit)=>Promise<Response>,
  stubTimers=false){
  const global=globalThis as unknown as {document:unknown;window:unknown};
  const previousDocument=global.document,previousWindow=global.window;
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
  const elements=new Map<string,Element>();
  const get=(id:string)=>{
    let element=elements.get(id);
    if(!element){element=new Element();elements.set(id,element);}
    return element;
  };
  const calls:string[]=[];
  global.document={getElementById:get,createElement:(tag:string)=>new Element(tag),visibilityState:'visible'};
  global.window={confirm:()=>true};
  let ui:ReturnType<typeof mountTaskConsole>|undefined;
  let scheduled:(()=>void)|undefined;
  if(stubTimers){
    globalThis.setTimeout=((callback:()=>void)=>{scheduled=callback;return 1;}) as unknown as typeof setTimeout;
    globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  }
  try {
    ui=mountTaskConsole(async(url,options)=>{calls.push(url);return await responder(url,options);},async()=>{});
    await ui.show();
    await run(get,ui,calls);
  } finally {
    ui?.hide();
    global.document=previousDocument;
    global.window=previousWindow;
    globalThis.setTimeout=originalSetTimeout;
    globalThis.clearTimeout=originalClearTimeout;
  }
  return scheduled;
}

test('switching conversation or status filters removes stale task actions immediately',async()=>{
  const a=task(one,A,'running');
  const b=task(two,B,'running');
  const mutations:string[]=[];
  await fixture(async(get,ui)=>{
    const rows=get('taskRows').children;
    const row=rows.find(item=>item.children[0]?.textContent.includes(one));
    assert.ok(row);row.onclick?.();
    await flush();
    const oldCancel=get('taskDetail').querySelector('.task-actions')?.children.find(item=>item.textContent==='Cancel task');
    assert.ok(oldCancel,'running task must have a cancel control');
    const select=get('taskConversationFilter');
    select.value=B;select.onchange?.();
    assert.equal(get('taskDetail').querySelector('.task-actions'),null,'changing conversation immediately clears old actions');
    assert.equal(get('taskDetail').querySelector('.task-timeline'),null);
    oldCancel.onclick?.();await flush();
    assert.equal(mutations.length,0,'detached controls must not dispatch mutations');
    assert.equal(get('taskRows').children.length,1);
    get('taskRows').children[0].onclick?.();
    await flush();
    assert.ok(get('taskDetail').querySelector('.task-actions'));
    const status=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Completed');
    assert.ok(status);status.onclick?.();
    assert.equal(get('taskDetail').querySelector('.task-actions'),null,'changing state immediately clears actions');
    assert.equal(get('taskRows').children.length,0,'no task matches the completed filter');
    ui.hide();
  },async(url,options)=>{
    if(options?.method==='POST'){mutations.push(url);return response({task:a});}
    if(url==='/sessions')return response({sessions});
    if(url.startsWith('/task-console/tasks?')){
      const search=new URL(url,'http://relay.local').searchParams;
      const scope=search.get('conversationId'),state=search.get('state');
      const tasks=[a,b].filter(item=>(!scope||item.conversationId===scope)&&(!state||item.state===state));
      return response({tasks,counts:{running:scope?1:2},nextCursor:null,hasMore:false});
    }
    if(url==='/task-console/tasks/'+one)return response({task:a,conversation:sessions[0],children:[],approvals:[]});
    if(url==='/task-console/tasks/'+two)return response({task:b,conversation:sessions[1],children:[],approvals:[]});
    if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
    throw Error('Unexpected URL '+url);
  });
});

test('task details expose the complete persisted result rather than only its first 2000 characters',async()=>{
  const full='Start '+('x'.repeat(10000))+' FINAL_RECOMMENDATION';
  const complete=task(one,A,'completed',full);
  await fixture(async(get)=>{
    get('taskRows').children[0].onclick?.();await flush();
    const result=get('taskDetail').querySelector('.task-result');
    assert.ok(result);
    assert.equal(result.textContent,full);
    assert.ok(result.textContent.endsWith('FINAL_RECOMMENDATION'));
  },async url=>{
    if(url==='/sessions')return response({sessions:[sessions[0]]});
    if(url.startsWith('/task-console/tasks?'))return response({tasks:[{...complete,result:full.slice(0,280)}],counts:{completed:1},nextCursor:null,hasMore:false});
    if(url==='/task-console/tasks/'+one)return response({task:complete,conversation:sessions[0],children:[],approvals:[]});
    if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
    throw Error('Unexpected URL '+url);
  });
});

test('activity polling advances past 2000 unrelated events to discover late task activity',async()=>{
  const selected=task(one,A,'running');
  const many=Array.from({length:2106},(_,index)=>({
    id:'event-'+index,sequence:index+1,timestamp:when,conversationId:A,
    taskId:index===2105?one:two,agentRunId:index===2105?one:two,
    type:'tool',state:'completed',tool:'atlas_status',invocationId:null,
    projectId:null,workspaceId:null,atlasOperationId:null,selectedNodeId:null,executingNodeId:null
  }));
  let scheduled:(()=>void)|undefined;
  const previous=globalThis.setTimeout,previousClear=globalThis.clearTimeout;
  // Controlled clock: allow an actual scheduled refresh cycle without waiting.
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui,calls)=>{
      get('taskRows').children[0].onclick?.();await flush();
      const empty=get('taskDetail').querySelector('.task-events-empty');
      assert.equal(empty?.textContent,'Scanning activity history…','replay backlog is not an empty timeline');
      assert.equal(calls.filter(path=>path.includes('/events?')).length,4,'one activity pass is capped at four pages');
      assert.ok(scheduled);
      scheduled();await flush();
      const timeline=get('taskDetail').querySelector('.task-timeline');
      assert.ok(timeline);
      assert.equal(timeline.children.filter(row=>row.className==='task-event').length,1);
      assert.ok(calls.some(path=>path.includes('events?after=2000')));
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/tasks?'))return response({tasks:[selected],counts:{running:1},nextCursor:null,hasMore:false});
      if(url==='/task-console/tasks/'+one)return response({task:selected,conversation:sessions[0],children:[],approvals:[]});
      if(url.includes('/events?')){
        const after=Number(new URL(url,'http://relay.local').searchParams.get('after'));
        const page=many.filter(event=>event.sequence>after).slice(0,500);
        return response({events:page,nextCursor:page.at(-1)?.sequence??after,hasMore:page.length===500});
      }
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=previous;
    globalThis.clearTimeout=previousClear;
  }
});
