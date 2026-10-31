import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountTaskConsole } from '../src/task-console.js';
import type { Task } from '../src/store.js';

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


const numbered=(id:number,state:Task['state']='running',conversationId=A):Task & {rowid:number}=>({
  ...task(String(id).padStart(8,'0')+'-1111-1111-1111-111111111111',conversationId,state),state,
  prompt:'Task '+id,createdAt:new Date(Date.parse(when)+id*1000).toISOString(),rowid:id
});
type Item=ReturnType<typeof numbered>;
function mock(items:Item[],url:string,options?:RequestInit):Response {
  if(url==='/sessions')return response({sessions});
  if(url.startsWith('/task-console/tasks?')){
    const query=new URL(url,'http://relay.local').searchParams;
    const conv=query.get('conversationId'),state=query.get('state'),cursor=query.get('cursor');
    const scoped=items.filter(t=>!conv||t.conversationId===conv);
    const counts:Record<string,number>={};
    for(const item of scoped)counts[item.state]=(counts[item.state]??0)+1;
    const eligible=scoped.filter(t=>(!state||t.state===state)&&(!cursor||t.rowid<Number(cursor)))
      .sort((a,b)=>b.rowid-a.rowid);
    const page=eligible.slice(0,50);
    return response({tasks:page,counts,hasMore:eligible.length>50,
      nextCursor:eligible.length>50?String(page.at(-1)?.rowid):null});
  }
  if(url.startsWith('/task-console/tasks/')){
    const id=url.split('/').at(-1),value=items.find(item=>item.id===id);
    if(!value)throw Error('Unknown task detail '+url);
    return response({task:value,conversation:sessions.find(s=>s.id===value.conversationId),children:[],approvals:[]});
  }
  if(url.includes('/events?'))return response({events:[],nextCursor:0,hasMore:false});
  if(options?.method==='POST')return response({});
  throw Error('Unexpected URL '+url);
}
async function withClock(run:(advance:()=>Promise<void>)=>Promise<void>) {
  const oldTimeout=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  let tick:(()=>void)|undefined;
  globalThis.setTimeout=((fn:()=>void)=>{tick=fn;return 1;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{tick=undefined;}) as typeof clearTimeout;
  try {
    await run(async()=>{assert.ok(tick,'poll scheduled');tick();await flush();});
  } finally {globalThis.setTimeout=oldTimeout;globalThis.clearTimeout=oldClear;}
}
const titles=(get:(id:string)=>Element)=>get('taskRows').children
  .filter(x=>x.className.split(' ').includes('task-row')).map(x=>x.children[0]?.textContent);
const selectStatus=(get:(id:string)=>Element,state:string)=>{
  const row=get('taskCounts').children.find(x=>x.children[0]?.textContent===state);
  assert.ok(row);row.onclick?.();
};

test('live polling remains bounded through many arrivals; history freezes and all old tasks stay reachable',async()=>{
  await withClock(async tick=>{
    const items=Array.from({length:60},(_,i)=>numbered(i+1));
    await fixture(async(get,_ui,calls)=>{
      assert.equal(titles(get).length,50);
      for(let id=61;id<=210;id++){
        items.push(numbered(id));await tick();
        assert.equal(titles(get).length,50,'live view is bounded at insertion '+id);
      }
      get('taskMore').onclick?.();await flush();
      assert.equal(titles(get).length,100);
      const before=titles(get);
      items.push(numbered(211));
      await tick();
      assert.deepEqual(titles(get),before,'history rows do not change under polling');
      assert.match(get('taskFeedback').textContent,/New task updates available/);
      assert.equal(get('taskCounts').children[0].children[1].textContent,'210',
        'history counts are frozen until Refresh');
      let pages=0;
      while(!get('taskMore').hidden&&pages++<10){get('taskMore').onclick?.();await flush();}
      assert.equal(pages,3,'three remaining older pages');
      const loaded=titles(get);
      assert.equal(loaded.length,210);
      assert.equal(new Set(loaded).size,210);
      assert.equal(get('taskMore').hidden,true);
      assert.ok(!loaded.includes('Task 211'));
      const cursors=calls.filter(url=>url.includes('&cursor=')).map(url=>Number(new URL(url,'http://relay.local').searchParams.get('cursor')));
      assert.deepEqual(cursors,[161,111,61,11],'one monotonically decreasing history cursor');
      get('taskRefresh').onclick?.();await flush();
      assert.equal(titles(get).length,50);
      assert.ok(titles(get).includes('Task 211'));
      assert.equal(get('taskCounts').children[0].children[1].textContent,'211');
      assert.equal(get('taskMore').hidden,false);
    },async(url,options)=>mock(items,url,options));
  });
});

test('50 to 51 tasks enables historical paging without reopening the workspace',async()=>{
  await withClock(async tick=>{
    const items=Array.from({length:50},(_,i)=>numbered(i+1));
    await fixture(async get=>{
      assert.equal(get('taskMore').hidden,true);
      items.push(numbered(51));await tick();
      assert.equal(titles(get).length,50);
      assert.equal(get('taskMore').hidden,false);
      get('taskMore').onclick?.();await flush();
      assert.equal(titles(get).length,51);
      assert.equal(new Set(titles(get)).size,51);
      assert.ok(titles(get).includes('Task 1'));
      assert.equal(get('taskMore').hidden,true);
    },async(url,options)=>mock(items,url,options));
  });
});

test('filters and selected actions are invalidated immediately when changing scope',async()=>{
  const a=numbered(1,'running',A),b=numbered(2,'running',B);
  const posts:string[]=[];
  await fixture(async get=>{
    get('taskRows').children[0].onclick?.();await flush();
    const oldCancel=get('taskDetail').querySelector('.task-actions')?.children.find(x=>x.textContent==='Cancel task');
    assert.ok(oldCancel);
    const conversation=get('taskConversationFilter');
    conversation.value=B;conversation.onchange?.();await flush();
    assert.equal(get('taskDetail').querySelector('.task-actions'),null);
    oldCancel.onclick?.();await flush();
    assert.equal(posts.length,0);
    assert.deepEqual(titles(get),['Task 2']);
    get('taskRows').children[0].onclick?.();await flush();
    selectStatus(get,'Completed');await flush();
    assert.equal(get('taskDetail').querySelector('.task-actions'),null);
    assert.equal(titles(get).length,0);
    assert.equal(get('taskRows').querySelector('.task-rows-empty')?.textContent,'No tasks match this filter.');
  },async(url,opts)=>{
    if(opts?.method==='POST'){posts.push(url);return response({});}
    return mock([a,b],url,opts);
  });
});

test('historical state membership stays frozen until explicit Refresh',async()=>{
  await withClock(async tick=>{
    const items=[numbered(1,'running'),...Array.from({length:60},(_,i)=>numbered(i+2,'completed'))];
    await fixture(async get=>{
      selectStatus(get,'Completed');await flush();
      get('taskMore').onclick?.();await flush();
      assert.equal(titles(get).length,60);
      assert.equal(get('taskMore').hidden,true);
      items[0].state='completed';
      await tick();
      assert.equal(titles(get).length,60,'history does not silently incorporate newly eligible tasks');
      assert.equal(get('taskMore').hidden,true);
      assert.match(get('taskFeedback').textContent,/New task updates available/);
      get('taskRefresh').onclick?.();await flush();
      assert.equal(titles(get).length,50);
      get('taskMore').onclick?.();await flush();
      assert.equal(titles(get).length,61,'fresh filter includes the task that completed');
      assert.ok(titles(get).includes('Task 1'));
    },async(url,opts)=>mock(items,url,opts));
  });
});

test('selection and related-task details remain independent from list mode and filters',async()=>{
  await withClock(async tick=>{
    const parent=numbered(1,'completed',B),child=numbered(2,'running',A);
    child.parentId=parent.id;
    const items=[parent,child];
    await fixture(async(get,_ui,calls)=>{
      selectStatus(get,'Running');await flush();
      const selector=get('taskConversationFilter');
      selector.value=A;selector.onchange?.();await flush();
      get('taskRows').children[0].onclick?.();await flush();
      const link=get('taskDetail').querySelector('.task-relation-link');
      assert.ok(link);link.onclick?.();await flush();
      assert.equal(get('taskDetail').querySelector('.task-detail-head')?.children[0].textContent,'Task 1');
      child.state='completed';await tick();
      assert.equal(titles(get).length,0);
      assert.equal(get('taskDetail').querySelector('.task-detail-head')?.children[0].textContent,'Task 1');
      assert.ok(calls.filter(url=>url==='/task-console/tasks/'+parent.id).length>=2);
      assert.equal(get('taskDetail').querySelector('.task-actions')?.children.some(x=>x.textContent==='Cancel task'),false);
    },async(url,opts)=>mock(items,url,opts));
  });
});

test('detail state refreshes independently while list is frozen, replacing obsolete actions',async()=>{
  await withClock(async tick=>{
    const items=Array.from({length:60},(_,i)=>numbered(i+1,'running'));
    await fixture(async get=>{
      get('taskRows').children[0].onclick?.();await flush();
      const cancel=get('taskDetail').querySelector('.task-actions')?.children.find(x=>x.textContent==='Cancel task');
      assert.ok(cancel);
      get('taskMore').onclick?.();await flush();
      items[59].state='completed';
      await tick();
      const head=get('taskDetail').querySelector('.task-detail-head');
      assert.ok(head?.children[1]?.textContent.includes('Completed'));
      assert.ok(!get('taskDetail').querySelector('.task-actions')?.children.some(x=>x.textContent==='Cancel task'));
      assert.equal(titles(get).length,60);
    },async(url,opts)=>mock(items,url,opts));
  });
});

test('a late live response cannot overwrite history started during polling',async()=>{
  await withClock(async tick=>{
    const items=Array.from({length:60},(_,i)=>numbered(i+1));
    let release:((value:Response)=>void)|undefined;
    let block=false;
    await fixture(async get=>{
      block=true;
      await tick();
      assert.ok(release,'live poll is in flight');
      get('taskMore').onclick?.();await flush();
      assert.equal(titles(get).length,100);
      items.push(numbered(61));
      release!(mock(items,'/task-console/tasks?limit=50'));
      await flush();
      assert.equal(titles(get).length,100);
      assert.ok(!titles(get).includes('Task 61'));
      assert.match(get('taskFeedback').textContent,/History/);
    },async(url,opts)=>{
      if(block&&url.startsWith('/task-console/tasks?')&&!url.includes('&cursor=')){
        block=false;
        return await new Promise<Response>(resolve=>{release=resolve;});
      }
      return mock(items,url,opts);
    });
  });
});

test('initially empty workspace shows a clear empty state',async()=>{
  await fixture(async get=>{
    assert.equal(titles(get).length,0);
    assert.equal(get('taskRows').querySelector('.task-rows-empty')?.textContent,'No tasks match this filter.');
  },async(url,opts)=>mock([],url,opts));
});

test('full task result remains available rather than truncated in the detail pane',async()=>{
  const item=numbered(1,'completed');
  item.result='start '+('x'.repeat(12000))+' END_REPORT';
  await fixture(async get=>{
    get('taskRows').children[0].onclick?.();await flush();
    assert.equal(get('taskDetail').querySelector('.task-result')?.textContent,item.result);
  },async(url,opts)=>mock([item],url,opts));
});
