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


test('new tasks cannot strand a displaced first-page row beyond the saved pagination cursor',async()=>{
  const numbered=(id:number)=>({
    ...task(String(id).padStart(8,'0')+'-1111-1111-1111-111111111111',A,'running'),
    prompt:'Number '+id,
    createdAt:new Date(Date.parse(when)+id*1000).toISOString(),
    rowid:id
  });
  const persisted=Array.from({length:60},(_,i)=>numbered(i+1));
  let scheduled:(()=>void)|undefined;
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui,calls)=>{
      assert.equal(get('taskRows').children.length,50);
      const displaced=persisted[10]; // rowid 11, original exclusive cursor
      const target=get('taskRows').children.find(row=>row.children[0]?.textContent==='Number 11');
      assert.ok(target);
      target.onclick?.();
      await flush();
      assert.ok(get('taskDetail').querySelector('.task-actions'),'the older selection should be actionable');
      persisted.push(numbered(61));
      assert.ok(scheduled);
      scheduled();await flush();
      // New rowid 61 pushes 11 from the first page. Rowid 11 must remain
      // present although the next pagination request is only for rowids <11.
      assert.equal(get('taskRows').children.length,51);
      assert.ok(get('taskRows').children.some(row=>row.children[0]?.textContent==='Number 11'));
      assert.ok(get('taskDetail').querySelector('.task-actions'),'displacement alone must not clear a selected older task');
      assert.ok(calls.some(url=>url.startsWith('/task-console/tasks?')));
      const latest=get('taskRows').children.find(row=>row.children[0]?.textContent==='Number 61');
      assert.ok(latest);latest.onclick?.();await flush();
      assert.equal(get('taskRows').children.length,50,'switching selection drops the displaced pinned row');
      assert.ok(!get('taskRows').children.some(row=>row.children[0]?.textContent==='Number 11'));
      get('taskMore').onclick?.();await flush();
      assert.equal(get('taskRows').children.length,60,'deep history reaches the original oldest task first');
      assert.ok(calls.some(url=>url.includes('cursor=11')),'deep pagination does not rewind');
      assert.equal(get('taskMore').hidden,false,'displaced newest-page gap remains available');
      get('taskMore').onclick?.();await flush();
      const titles=get('taskRows').children.map(row=>row.children[0]?.textContent);
      assert.equal(titles.length,61,'the complete 60→61 history remains reachable');
      assert.equal(new Set(titles).size,61,'no task appears twice');
      for(let i=1;i<=61;i++)assert.ok(titles.includes('Number '+i),'missing rowid '+i);
      assert.ok(calls.some(url=>url.includes('cursor=12')),'separate gap cursor recovers displaced rowid 11');
      assert.equal(displaced.rowid,11);
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/task-states?')) {
        const ids=new URL(url,'http://relay.local').searchParams.get('ids')?.split(',')??[];
        return response({states:Object.fromEntries(persisted.filter(item=>ids.includes(item.id))
          .map(item=>[item.id,{state:item.state,conversationId:item.conversationId}]))});
      }
      if(url.startsWith('/task-console/tasks?')){
        const query=new URL(url,'http://relay.local').searchParams;
        const cursor=query.get('cursor'),limit=Number(query.get('limit')??50);
        const eligible=persisted.filter(item=>cursor===null||item.rowid<Number(cursor)).sort((a,b)=>b.rowid-a.rowid);
        const page=eligible.slice(0,limit);
        return response({tasks:page,counts:{running:persisted.length},
          nextCursor:eligible.length>limit?String(page.at(-1)?.rowid):null,hasMore:eligible.length>limit});
      }
      const id=url.split('/task-console/tasks/')[1];
      const found=persisted.find(item=>item.id===id);
      if(found)return response({task:found,conversation:sessions[0],children:[],approvals:[]});
      if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=originalSetTimeout;
    globalThis.clearTimeout=originalClearTimeout;
  }
});

test('running filter automatically clears completed selection after a foreground poll',async()=>{
  let persisted=task(one,A,'running');
  let scheduled:(()=>void)|undefined;
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui,calls)=>{
      const running=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Running');
      assert.ok(running);running.onclick?.();await flush();
      get('taskRows').children[0].onclick?.();await flush();
      assert.ok(get('taskDetail').querySelector('.task-actions')?.children.some(b=>b.textContent==='Cancel task'));
      persisted=task(one,A,'completed','Done');
      assert.ok(scheduled);
      scheduled();await flush();
      assert.equal(get('taskRows').children.filter(row=>row.className.split(' ').includes('task-row')).length,0,
        'completed task disappears from running list');
      assert.equal(get('taskDetail').querySelector('.task-actions'),null,
        'the stale cancel action is no longer rendered');
      assert.ok(get('taskDetail').children[0]?.textContent.includes('Select a task'),
        'detail returns to empty selected state');
      assert.ok(calls.some(url=>url==='/task-console/tasks/'+one),
        'selection is reconciled against authoritative detail after task leaves page');
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/tasks?')){
        const state=new URL(url,'http://relay.local').searchParams.get('state');
        const tasks=state&&persisted.state!==state?[]:[persisted];
        return response({tasks,counts:{[persisted.state]:1},nextCursor:null,hasMore:false});
      }
      if(url==='/task-console/tasks/'+one)return response({task:persisted,conversation:sessions[0],children:[],approvals:[]});
      if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=originalSetTimeout;
    globalThis.clearTimeout=originalClearTimeout;
  }
});


test('a complete filtered page evicts nonselected tasks that left the filter',async()=>{
  let primary=task(one,A,'running');
  const remaining=task(two,A,'running');
  let scheduled:(()=>void)|undefined;
  const previousTimeout=globalThis.setTimeout,previousClear=globalThis.clearTimeout;
  globalThis.setTimeout=((callback:()=>void)=>{scheduled=callback;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get)=>{
      const running=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Running');
      assert.ok(running);running.onclick?.();await flush();
      assert.equal(get('taskRows').children.filter(row=>row.className.split(' ').includes('task-row')).length,2);
      primary=task(one,A,'completed');
      assert.ok(scheduled);scheduled();await flush();
      const names=get('taskRows').children.filter(row=>row.className.split(' ').includes('task-row'))
        .map(row=>row.children[0]?.textContent);
      assert.deepEqual(names,['Work '+two],'the completed task must not remain as a stale running row');
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/tasks?')) {
        const state=new URL(url,'http://relay.local').searchParams.get('state');
        const tasks=[primary,remaining].filter(item=>!state||item.state===state);
        return response({tasks,counts:{running:tasks.length},hasMore:false,nextCursor:null});
      }
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=previousTimeout;
    globalThis.clearTimeout=previousClear;
  }
});


test('an older selected task is preserved while in scope and cleared after its state changes',async()=>{
  const items=Array.from({length:53},(_,i)=>({
    ...task(String(i+1).padStart(8,'0')+'-2222-2222-2222-222222222222',A,'running'),
    createdAt:new Date(Date.parse(when)+(i+1)*1000).toISOString(),
    prompt:'Older '+(i+1),rowid:i+1
  }));
  const oldest=items[0];
  const mutations:string[]=[];
  let scheduled:(()=>void)|undefined;
  const oldTimeout=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui)=>{
      const running=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Running');
      assert.ok(running);running.onclick?.();await flush();
      get('taskMore').onclick?.();await flush();
      assert.equal(get('taskRows').children.filter(row=>row.className.split(' ').includes('task-row')).length,53);
      const row=get('taskRows').children.find(item=>item.children[0]?.textContent==='Older 1');
      assert.ok(row);row.onclick?.();await flush();
      const cancel=get('taskDetail').querySelector('.task-actions')?.children.find(b=>b.textContent==='Cancel task');
      assert.ok(cancel);
      assert.ok(scheduled);scheduled();await flush();
      assert.ok(get('taskDetail').querySelector('.task-actions'),'old in-scope task is retained');
      oldest.state='completed';
      assert.ok(scheduled);scheduled();await flush();
      assert.equal(get('taskDetail').querySelector('.task-actions'),null);
      assert.equal(get('taskDetail').children[0]?.textContent,'Select a task to inspect its work.');
      assert.ok(!get('taskRows').children.some(item=>item.children[0]?.textContent==='Older 1'));
      cancel.onclick?.();await flush();
      assert.equal(mutations.length,0,'detached cancel never dispatches a mutation');
    },async(url,options)=>{
      if(options?.method==='POST'){mutations.push(url);return response({});}
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/task-states?')) {
        const ids=new URL(url,'http://relay.local').searchParams.get('ids')?.split(',')??[];
        return response({states:Object.fromEntries(items.filter(item=>ids.includes(item.id))
          .map(item=>[item.id,{state:item.state,conversationId:item.conversationId}]))});
      }
      if(url.startsWith('/task-console/tasks?')){
        const search=new URL(url,'http://relay.local').searchParams;
        const eligible=items.filter(item=>(!search.get('state')||item.state===search.get('state'))&&
          (!search.get('cursor')||item.rowid<Number(search.get('cursor'))))
          .sort((a,b)=>b.rowid-a.rowid);
        const page=eligible.slice(0,50);
        return response({tasks:page,counts:{running:items.filter(item=>item.state==='running').length},
          nextCursor:eligible.length>50?String(page.at(-1)?.rowid):null,hasMore:eligible.length>50});
      }
      const selected=items.find(item=>url==='/task-console/tasks/'+item.id);
      if(selected)return response({task:selected,conversation:sessions[0],children:[],approvals:[]});
      if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=oldTimeout;
    globalThis.clearTimeout=oldClear;
  }
});


test('nonexhaustive queued filter evicts an unselected task that starts running',async()=>{
  const items=Array.from({length:60},(_,i)=>({
    ...task(String(i+1).padStart(8,'0')+'-3333-3333-3333-333333333333',A,'queued'),
    prompt:'Queue '+(i+1),createdAt:new Date(Date.parse(when)+(i+1)*1000).toISOString(),rowid:i+1
  }));
  const changed=items[39];
  let scheduled:(()=>void)|undefined;
  const oldTimeout=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_,calls)=>{
      const queued=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Queued');
      assert.ok(queued);queued.onclick?.();await flush();
      assert.equal(get('taskRows').children.length,50);
      changed.state='running';
      assert.ok(scheduled);scheduled();await flush();
      const visible=get('taskRows').children.map(row=>row.children[0]?.textContent);
      assert.equal(visible.length,50);
      assert.ok(!visible.includes('Queue 40'),'transitioned unselected row is not retained as queued');
      assert.equal(get('taskCounts').children.find(item=>item.children[0]?.textContent==='Queued')?.children[1]?.textContent,'59');
      assert.ok(!calls.some(url=>url.includes('/task-console/task-states?')&&
        new URL(url,'http://relay.local').searchParams.get('ids')?.split(',').includes(changed.id)),
        'displaced unselected rows are discarded rather than indefinitely materialized');
      get('taskMore').onclick?.();await flush();
      const all=get('taskRows').children.map(row=>row.children[0]?.textContent);
      assert.equal(all.length,59,'all and only queued tasks remain after pagination');
      assert.ok(!all.includes('Queue 40'));
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/task-states?')){
        const ids=new URL(url,'http://relay.local').searchParams.get('ids')?.split(',')??[];
        return response({states:Object.fromEntries(items.filter(item=>ids.includes(item.id))
          .map(item=>[item.id,{state:item.state,conversationId:item.conversationId}]))});
      }
      if(url.startsWith('/task-console/tasks?')){
        const search=new URL(url,'http://relay.local').searchParams;
        const eligible=items.filter(item=>item.state===search.get('state')&&
          (!search.get('cursor')||item.rowid<Number(search.get('cursor')))).sort((a,b)=>b.rowid-a.rowid);
        const page=eligible.slice(0,50);
        return response({tasks:page,counts:{queued:items.filter(item=>item.state==='queued').length,running:items.filter(item=>item.state==='running').length},
          hasMore:eligible.length>50,nextCursor:eligible.length>50?String(page.at(-1)?.rowid):null});
      }
      throw Error('Unexpected URL '+url);
    });
  } finally {globalThis.setTimeout=oldTimeout;globalThis.clearTimeout=oldClear;}
});

test('exhausted older-page cursor stays exhausted through repeated foreground polls',async()=>{
  const items=Array.from({length:60},(_,i)=>({
    ...task(String(i+1).padStart(8,'0')+'-4444-4444-4444-444444444444',A,'completed'),
    prompt:'Page '+(i+1),createdAt:new Date(Date.parse(when)+(i+1)*1000).toISOString(),rowid:i+1
  }));
  let scheduled:(()=>void)|undefined;
  const oldTimeout=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_,calls)=>{
      assert.equal(get('taskRows').children.length,50);
      assert.equal(get('taskMore').hidden,false);
      get('taskMore').onclick?.();await flush();
      assert.equal(get('taskRows').children.length,60);
      assert.equal(get('taskMore').hidden,true);
      const olderCalls=()=>calls.filter(url=>url.includes('cursor=')).length;
      assert.equal(olderCalls(),1);
      assert.ok(scheduled);scheduled();await flush();
      assert.equal(get('taskMore').hidden,true,'polling must not revive an exhausted cursor');
      get('taskMore').onclick?.();await flush();
      assert.equal(olderCalls(),1,'no repeat older-page request after exhaustion');
      assert.equal(get('taskRows').children.length,60);
      assert.ok(scheduled);scheduled();await flush();
      assert.equal(get('taskMore').hidden,true);
      assert.equal(new Set(get('taskRows').children.map(row=>row.children[0]?.textContent)).size,60);
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/task-states?')){
        const ids=new URL(url,'http://relay.local').searchParams.get('ids')?.split(',')??[];
        return response({states:Object.fromEntries(items.filter(item=>ids.includes(item.id))
          .map(item=>[item.id,{state:item.state,conversationId:item.conversationId}]))});
      }
      if(url.startsWith('/task-console/tasks?')){
        const search=new URL(url,'http://relay.local').searchParams;
        const eligible=items.filter(item=>!search.get('cursor')||item.rowid<Number(search.get('cursor'))).sort((a,b)=>b.rowid-a.rowid);
        const page=eligible.slice(0,50);
        return response({tasks:page,counts:{completed:60},hasMore:eligible.length>50,
          nextCursor:eligible.length>50?String(page.at(-1)?.rowid):null});
      }
      throw Error('Unexpected URL '+url);
    });
  } finally {globalThis.setTimeout=oldTimeout;globalThis.clearTimeout=oldClear;}
});

test('empty initial page and zero-result state filter both render a visible empty message',async()=>{
  await fixture(async get=>{
    assert.equal(get('taskRows').querySelector('.task-rows-empty')?.textContent,'No tasks match this filter.');
  },async url=>{
    if(url==='/sessions')return response({sessions:[sessions[0]]});
    if(url.startsWith('/task-console/tasks?'))return response({tasks:[],counts:{},hasMore:false,nextCursor:null});
    throw Error('Unexpected URL '+url);
  });
  const running=task(one,A,'running');
  await fixture(async get=>{
    assert.equal(get('taskRows').querySelector('.task-rows-empty'),null);
    const completed=get('taskCounts').children.find(item=>item.children[0]?.textContent==='Completed');
    assert.ok(completed);completed.onclick?.();await flush();
    assert.equal(get('taskRows').querySelector('.task-rows-empty')?.textContent,'No tasks match this filter.');
    assert.equal(get('taskRows').children.length,1,'empty placeholder is not duplicated');
  },async url=>{
    if(url==='/sessions')return response({sessions:[sessions[0]]});
    if(url.startsWith('/task-console/tasks?')){
      const state=new URL(url,'http://relay.local').searchParams.get('state');
      return response({tasks:state==='completed'?[]:[running],counts:{running:1},hasMore:false,nextCursor:null});
    }
    throw Error('Unexpected URL '+url);
  });
});


test('hundreds of automatic page shifts keep the DOM bounded and history reachable on demand',async()=>{
  const make=(number:number)=>({
    ...task(String(number).padStart(8,'0')+'-5555-5555-5555-555555555555',A,'completed'),
    prompt:'History '+number,rowid:number,
    createdAt:new Date(Date.parse(when)+number*1000).toISOString()
  });
  const history=Array.from({length:60},(_,i)=>make(i+1));
  let scheduled:(()=>void)|undefined;
  const previousTimeout=globalThis.setTimeout,previousClear=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui,calls)=>{
      assert.equal(get('taskRows').children.length,50);
      for(let number=61;number<=210;number++) {
        history.push(make(number));
        assert.ok(scheduled);
        scheduled();await flush();
        assert.ok(get('taskRows').children.length<=50,
          'background inserts must not accumulate DOM rows: '+number);
      }
      assert.equal(get('taskRows').children.length,50);
      assert.equal(get('taskMore').hidden,false);
      for(let i=0;i<10&&!get('taskMore').hidden;i++){
        get('taskMore').onclick?.();await flush();
      }
      const visible=get('taskRows').children.map(row=>row.children[0]?.textContent);
      assert.equal(visible.length,210,'all historic tasks remain reachable with explicit paging');
      assert.equal(new Set(visible).size,210,'overlapping cursors must not duplicate rows');
      assert.equal(get('taskMore').hidden,true,'older pagination terminates after all tasks');
      for(let number=1;number<=210;number++)
        assert.ok(visible.includes('History '+number),'missing historic task '+number);
      assert.ok(calls.some(url=>url.includes('cursor=161')),
        'paging resumes just below the newest page after all 150 inserts');
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/tasks?')){
        const search=new URL(url,'http://relay.local').searchParams;
        const eligible=history.filter(item=>!search.get('cursor')||item.rowid<Number(search.get('cursor')))
          .sort((a,b)=>b.rowid-a.rowid);
        const page=eligible.slice(0,50);
        return response({tasks:page,counts:{completed:history.length},hasMore:eligible.length>50,
          nextCursor:eligible.length>50?String(page.at(-1)?.rowid):null});
      }
      throw Error('Unexpected URL '+url);
    });
  } finally {
    globalThis.setTimeout=previousTimeout;
    globalThis.clearTimeout=previousClear;
  }
});


test('interleaved manual pagination and new arrivals never rewind deep-history progress',async()=>{
  const make=(id:number)=>({
    ...task(String(id).padStart(8,'0')+'-6666-6666-6666-666666666666',A,'completed'),
    prompt:'Interleaved '+id,rowid:id,
    createdAt:new Date(Date.parse(when)+id*1000).toISOString()
  });
  const persisted=Array.from({length:200},(_,i)=>make(i+1));
  let scheduled:(()=>void)|undefined;
  const originalTimer=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  globalThis.setTimeout=((fn:()=>void)=>{scheduled=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{scheduled=undefined;}) as typeof clearTimeout;
  try {
    await fixture(async(get,_ui,calls)=>{
      const pageCursors=()=>calls.filter(url=>url.startsWith('/task-console/tasks?')&&url.includes('cursor='))
        .map(url=>Number(new URL(url,'http://relay.local').searchParams.get('cursor')));
      assert.equal(get('taskRows').children.length,50);
      assert.ok(scheduled);

      get('taskMore').onclick?.();await flush(); // 150..101
      persisted.push(make(201));
      scheduled();await flush();
      get('taskMore').onclick?.();await flush(); // 100..51, not 151..102
      persisted.push(make(202));
      scheduled();await flush();
      get('taskMore').onclick?.();await flush(); // 50..1
      assert.deepEqual(pageCursors().slice(0,3),[151,101,51],
        'deep cursor must advance monotonically even across newest-page shifts');
      assert.ok(get('taskRows').children.some(item=>item.children[0]?.textContent==='Interleaved 1'));
      assert.equal(get('taskRows').children.length,200,
        'only genuinely displaced newest-page rows remain unloaded');
      assert.equal(get('taskMore').hidden,false,'the two displaced rows are still reachable');

      get('taskMore').onclick?.();await flush(); // gap snapshot 153..151
      assert.equal(pageCursors()[3],153);
      let visible=get('taskRows').children.map(item=>item.children[0]?.textContent);
      assert.equal(new Set(visible).size,202);
      assert.equal(visible.length,202);
      assert.equal(get('taskMore').hidden,true);

      // A new insert after finishing the gap creates a NEW, independent gap.
      persisted.push(make(203));scheduled();await flush();
      assert.equal(get('taskMore').hidden,false);
      get('taskMore').onclick?.();await flush();
      assert.equal(pageCursors()[4],154,'new gap starts above the previously filled boundary');
      visible=get('taskRows').children.map(item=>item.children[0]?.textContent);
      assert.equal(new Set(visible).size,203);
      assert.equal(get('taskMore').hidden,true);
    },async url=>{
      if(url==='/sessions')return response({sessions:[sessions[0]]});
      if(url.startsWith('/task-console/task-states?')){
        const ids=new URL(url,'http://relay.local').searchParams.get('ids')?.split(',')??[];
        return response({states:Object.fromEntries(persisted.filter(item=>ids.includes(item.id))
          .map(item=>[item.id,{state:item.state,conversationId:item.conversationId}]))});
      }
      if(url.startsWith('/task-console/tasks?')){
        const query=new URL(url,'http://relay.local').searchParams;
        const filtered=persisted.filter(item=>!query.get('cursor')||item.rowid<Number(query.get('cursor')))
          .sort((a,b)=>b.rowid-a.rowid);
        const page=filtered.slice(0,50);
        return response({tasks:page,counts:{completed:persisted.length},
          hasMore:filtered.length>50,nextCursor:filtered.length>50?String(page.at(-1)?.rowid):null});
      }
      throw Error('Unexpected request '+url);
    });
  } finally {
    globalThis.setTimeout=originalTimer;
    globalThis.clearTimeout=originalClear;
  }
});
