import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

// Exercise the compiled browser bundle against a small DOM that implements
// insertion/movement semantics, including native <details> open state.
const source=readFileSync(new URL('../dist/public/app.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve));};

class Element {
  readonly children:Element[]=[];
  readonly dataset:Record<string,string>={};
  parent:Element|null=null;
  textContent='';className='';value='';hidden=false;disabled=false;
  title='';open=false;scrollHeight=0;scrollTop=0;clientHeight=0;
  style={left:'',top:''}; attributes:Record<string,string>={};
  onclick?:()=>void;
  onsubmit?:()=>void;
  onkeydown?:()=>void;
  oninput?:()=>void;
  onclose?:()=>void;
  constructor(readonly tag='div'){}
  append(...nodes:Element[]){for(const node of nodes)this.insertBefore(node,null);}
  insertBefore(node:Element,before:Element|null) {
    if(node.parent){const index=node.parent.children.indexOf(node);if(index>=0)node.parent.children.splice(index,1);}
    const index=before?this.children.indexOf(before):-1;
    this.children.splice(index<0?this.children.length:index,0,node);
    node.parent=this;
    return node;
  }
  replaceChildren(...nodes:Element[]){for(const child of this.children)child.parent=null;this.children.splice(0);this.append(...nodes);}
  get lastElementChild():Element|null{return this.children.at(-1)??null;}
  remove(){if(this.parent){const index=this.parent.children.indexOf(this);if(index>=0)this.parent.children.splice(index,1);this.parent=null;}}
  focus(){}
  select(){}
  getBoundingClientRect(){return {right:215,bottom:120};}
  showModal(){this.open=true;}
  close(){this.open=false;this.onclose?.();}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
}

const event=(id:string,sequence:number)=>({
  schemaVersion:1,id,sequence,timestamp:'2026-10-31T00:00:00Z',
  conversationId:'c1',taskId:'task',agentRunId:'task',invocationId:null,
  type:'task',state:'completed',tool:null,atlasOperationId:null,
  projectId:null,workspaceId:null,selectedNodeId:null,executingNodeId:null
});
const snapshot=(id:string)=>({session:{id,title:'Conversation '+id,busy:false,costUsd:0,usage:{costKind:'estimated',tokens:0,unknown:false}},tasks:[],approvals:[]});

test('Activity details stay expanded across idle polls and newly prepended events; switching sessions clears them',async()=>{
  const nodes=new Map<string,Element>();
  const element=(id:string):Element=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
  const events=new Map([['c1',[event('event-1',1)]],['c2',[{...event('event-2',2),conversationId:'c2'}]]]);
  let nextPoll:(()=>void)|undefined;
  const context={
    window:{location:{protocol:'https:'},sessionStorage:{getItem:()=>null,setItem:()=>{}}},
    document:{getElementById:element,createElement:(name:string)=>new Element(name)},
    Headers,Response,
    setTimeout:(callback:()=>void,_ms:number)=>{nextPoll=callback;return 1;},
    clearTimeout:(_id:number)=>{nextPoll=undefined;},
    fetch:async (url:string)=>{
      if(url==='/api/status')return new Response(JSON.stringify({provider:'OpenRouter',model:'free-model',atlas:'configured'}));
      if(url==='/api/sessions')return new Response(JSON.stringify({sessions:[{id:'c1',title:'Conversation c1'},{id:'c2',title:'Conversation c2'}]}));
      const match=url.match(/^\/api\/sessions\/(c[12])(?:\/events\?after=(\d+))?$/);
      if(!match)throw Error('unexpected URL '+url);
      if(!url.includes('/events'))return new Response(JSON.stringify(snapshot(match[1])));
      const after=Number(match[2]);const unseen=(events.get(match[1])??[]).filter(e=>e.sequence>after);
      return new Response(JSON.stringify({events:unseen,nextCursor:unseen.at(-1)?.sequence??after,hasMore:false}));
    }
  };
  runInNewContext(source,context,{filename:'dist/public/app.js'});
  await flush();
  const list=element('activity');
  assert.equal(list.children.length,1);
  const original=list.children[0];
  original.open=true;

  const pollAgain=nextPoll;
  assert.ok(pollAgain);
  pollAgain();
  await flush();
  assert.strictEqual(list.children[0],original,'idle polling must reuse the same native details element');
  assert.equal(original.open,true);

  events.get('c1')!.push(event('event-new',3));
  const pollWithEvent=nextPoll;
  assert.ok(pollWithEvent);
  pollWithEvent();
  await flush();
  assert.equal(list.children.length,2);
  assert.equal(list.children[0].dataset.eventId,'event-new');
  assert.strictEqual(list.children[1],original,'new events must not replace the expanded row');
  assert.equal(original.open,true);

  const second=element('sessions').children[1].children.find(x=>x.className.includes('session'))!;
  assert.ok(second.onclick);
  second.onclick();
  await flush();
  assert.equal(list.children.length,1);
  assert.equal(list.children[0].dataset.eventId,'event-2');
  assert.notStrictEqual(list.children[0],original,'session switches must discard old activity rows');
});

test('Atlas receipts render beside a Markdown response without injecting model HTML',async()=>{
  const nodes=new Map<string,Element>();
  const element=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
  const task={id:'t1',conversationId:'c1',prompt:'Get Atlas status',result:'**Atlas active**\n\n<script>alert(1)</script>',state:'completed',error:null,usage:[]};
  const receipt={...event('tool-1',1),type:'tool',state:'completed',taskId:'t1',invocationId:'call-1',tool:'get_atlas_status'};
  let timeout:(()=>void)|undefined;
  const context={
    window:{location:{protocol:'https:'},sessionStorage:{getItem:()=>null,setItem:()=>{}}},
    document:{getElementById:element,createElement:(tag:string)=>new Element(tag)},
    Headers,Response,URL,
    setTimeout:(fn:()=>void)=>{timeout=fn;return 1;},
    clearTimeout:()=>{timeout=undefined;},
    fetch:async(url:string)=>{
      if(url==='/api/status')return new Response(JSON.stringify({provider:'OpenRouter',model:'test-free',atlas:'configured'}));
      if(url==='/api/sessions')return new Response(JSON.stringify({sessions:[{id:'c1',title:'Atlas status'}]}));
      if(url==='/api/sessions/c1')return new Response(JSON.stringify({session:{id:'c1',title:'Atlas status',busy:false,costUsd:0,usage:{costKind:'estimated',tokens:20,unknown:false}},tasks:[task],approvals:[]}));
      if(url.startsWith('/api/sessions/c1/events?after='))return new Response(JSON.stringify({events:url.endsWith('=0')?[receipt]:[],nextCursor:1,hasMore:false}));
      throw Error('unexpected '+url);
    }
  };
  runInNewContext(source,context,{filename:'dist/public/app.js'});
  await flush();
  const message=element('messages');
  assert.ok(message.children.some(x=>x.className==='message assistant'));
  const assistant=message.children.find(x=>x.className==='message assistant')!;
  const pills=assistant.children.find(x=>x.className==='inline-tools');
  assert.ok(pills,'tool action should be adjacent to its assistant response');
  assert.ok(pills.children[0].children.some(x=>x.textContent==='Get Atlas Status'));
  const markdown=assistant.children.find(x=>x.className==='markdown');
  assert.ok(markdown);
  const elements=(root:Element):Element[]=>[root,...root.children.flatMap(elements)];
  assert.ok(!elements(markdown).some(x=>x.tag==='script'),'untrusted model markup must stay text');
  assert.ok(elements(markdown).some(x=>x.textContent.includes('<script>')));
  assert.ok(timeout,'polling should remain active after tool events');
});

test('newly titled first-message chats are searchable without navigation or refresh',async()=>{
  const nodes=new Map<string,Element>();
  const element=(id:string):Element=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
  let title='New conversation',task:Record<string,unknown>|undefined;
  let nextPoll:(()=>void)|undefined;
  let sessionListings=0;
  const context={
    window:{location:{protocol:'https:'},sessionStorage:{getItem:()=>null,setItem:()=>{}}},
    document:{getElementById:element,createElement:(tag:string)=>new Element(tag)},
    Headers,Response,URL,crypto:{randomUUID:()=> 'request-id-001'},
    setTimeout:(fn:()=>void)=>{nextPoll=fn;return 1;},
    clearTimeout:()=>{nextPoll=undefined;},
    fetch:async(url:string,options?:RequestInit)=>{
      if(url==='/api/status')return new Response(JSON.stringify({provider:'OpenRouter',model:'free-model',atlas:'configured'}));
      if(url==='/api/sessions'){sessionListings++;return new Response(JSON.stringify({sessions:[{id:'c1',title:'New conversation'}]}));}
      if(url==='/api/sessions/c1/messages' && options?.method==='POST'){
        task={id:'t1',prompt:'Investigate build failures',result:'',state:'queued',error:null,usage:[]};
        title='Investigate build failures';
        return new Response(JSON.stringify({task}),{status:202});
      }
      if(url==='/api/sessions/c1')
        return new Response(JSON.stringify({session:{id:'c1',title,busy:false,costUsd:0,usage:{costKind:'estimated',tokens:0,unknown:false}},tasks:task?[task]:[],approvals:[]}));
      if(url.startsWith('/api/sessions/c1/events?after='))
        return new Response(JSON.stringify({events:[],nextCursor:0,hasMore:false}));
      throw Error('unexpected '+url);
    }
  };
  runInNewContext(source,context,{filename:'dist/public/app.js'});
  await flush();
  const prompt=element('prompt');
  prompt.value='Investigate build failures';
  (element('form').onsubmit as unknown as ((e:{preventDefault():void})=>void))?.({preventDefault(){}});
  await flush();
  const search=element('sessionSearch');
  search.value='build';
  search.oninput?.();
  assert.equal(sessionListings,2,'send path should not require a third sessions refresh');
  const matches=element('sessions').children;
  assert.equal(matches.length,1);
  const conversationButton=matches[0].children.find(child=>child.className.includes('session'))!;
  assert.equal(conversationButton.title,'Investigate build failures');
  assert.ok(conversationButton.children.some(child=>child.textContent==='Investigate build failures'));
  assert.ok(nextPoll,'polling remains scheduled');
});

test('Atlas receipts survive >500 event replay, 300-event inspector eviction and reloading',async()=>{
  const receipts=[{...event('receipt-1',1),type:'tool',taskId:'t1',invocationId:'inv-1',tool:'get_atlas_status',state:'completed'}];
  const all=[...receipts,...Array.from({length:605},(_,i)=>event('event-'+i,i+2))];
  const task={id:'t1',conversationId:'c1',prompt:'Atlas status',result:'All healthy',state:'completed',error:null,usage:[]};
  for(let load=0;load<2;load++){
    const nodes=new Map<string,Element>();
    const element=(id:string):Element=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
    let nextPoll:(()=>void)|undefined;
    const context={
      window:{location:{protocol:'https:'},sessionStorage:{getItem:()=>null,setItem:()=>{}}},
      document:{getElementById:element,createElement:(tag:string)=>new Element(tag)},
      Headers,Response,URL,
      setTimeout:(fn:()=>void)=>{nextPoll=fn;return 1;},
      clearTimeout:()=>{nextPoll=undefined;},
      fetch:async(url:string)=>{
        if(url==='/api/status')return new Response(JSON.stringify({provider:'OpenRouter',model:'free-model',atlas:'configured'}));
        if(url==='/api/sessions')return new Response(JSON.stringify({sessions:[{id:'c1',title:'Atlas status'}]}));
        if(url==='/api/sessions/c1')
          return new Response(JSON.stringify({session:{id:'c1',title:'Atlas status',busy:false,costUsd:0,usage:{costKind:'estimated',tokens:10,unknown:false}},tasks:[task],approvals:[]}));
        if(url.startsWith('/api/sessions/c1/events?after=')){
          const after=Number(url.split('=')[1]);
          const batch=all.filter(e=>e.sequence>after).slice(0,500);
          return new Response(JSON.stringify({events:batch,nextCursor:batch.at(-1)?.sequence??after,hasMore:batch.length===500}));
        }
        throw Error('unexpected '+url);
      }
    };
    runInNewContext(source,context,{filename:'dist/public/app.js'});
    await flush();
    assert.ok(nextPoll,'expected a scheduled history replay poll');
    const next=nextPoll;next();
    await flush();
    const messages=element('messages');
    const assistant=messages.children.find(x=>x.className==='message assistant');
    assert.ok(assistant);
    const pills=assistant.children.find(x=>x.className==='inline-tools');
    assert.ok(pills,'first tool invocation must remain visible after inspector trims older events');
    assert.equal(pills.children.length,1);
    assert.equal(pills.children[0].children.at(-1)?.textContent,'completed');
    assert.equal(element('activity').children.length,100,'inspector remains capped at latest 100 visible rows');
  }
});

test('conversation menu renames and deletes only after confirmation; failed requests keep dialog state',async()=>{
  const nodes=new Map<string,Element>();
  const element=(id:string):Element=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
  let sessions=[{id:'c1',title:'First',modelKey:'free'}, {id:'c2',title:'Second',modelKey:'free'}];
  let deleted=false,blocked=true,patches=0,deletes=0;
  const context={
    window:{location:{protocol:'https:'},innerWidth:1000,innerHeight:600,sessionStorage:{getItem:()=>null,setItem:()=>{}}},
    document:{getElementById:element,createElement:(name:string)=>new Element(name)},
    Headers,Response,URL,
    setTimeout:(_fn:()=>void)=>1, clearTimeout:()=>{},
    fetch:async(url:string,opts?:RequestInit)=>{
      if(url==='/api/status')return new Response(JSON.stringify({provider:'OpenRouter',model:'free',atlas:'configured'}));
      if(url==='/api/sessions')return new Response(JSON.stringify({sessions}));
      if(url==='/api/sessions/c1' && opts?.method==='PATCH'){
        patches++;
        const title=(JSON.parse(opts.body as string) as {title:string}).title;
        sessions=sessions.map(s=>s.id==='c1'?{...s,title}:s);
        return new Response(JSON.stringify({session:{...sessions[0],busy:false,costUsd:0,usage:{tokens:0,unknown:false}}}));
      }
      if(url==='/api/sessions/c1' && opts?.method==='DELETE'){
        deletes++;
        if(blocked)return new Response(JSON.stringify({error:'Conversation has active or uncertain tasks'}),{status:409});
        deleted=true;sessions=sessions.filter(s=>s.id!=='c1');
        return new Response(null,{status:204});
      }
      const match=url.match(/^\/api\/sessions\/(c[12])$/);
      if(match) {
        const selected=sessions.find(s=>s.id===match[1]);
        return new Response(JSON.stringify({session:{...selected,busy:false,costUsd:0,usage:{costKind:'estimated',tokens:0,unknown:false}},tasks:[],approvals:[]}));
      }
      if(url.startsWith('/api/sessions/c1/events?after=')||url.startsWith('/api/sessions/c2/events?after='))
        return new Response(JSON.stringify({events:[],nextCursor:0,hasMore:false}));
      throw Error('Unexpected '+url);
    }
  };
  runInNewContext(source,context,{filename:'dist/public/app.js'});
  await flush();
  const firstRow=element('sessions').children[0];
  const more=firstRow.children.find(e=>e.className==='session-more')!;
  assert.ok(more,'chat actions button present');
  (more.onclick as unknown as ((e:{stopPropagation():void})=>void))({stopPropagation(){}});
  assert.equal(element('sessionMenu').hidden,false);
  element('menuRename').onclick?.();
  assert.equal(element('renameDialog').open,true);
  assert.equal(element('renameInput').value,'First');
  element('renameInput').value='  ';
  (element('renameForm').onsubmit as unknown as ((e:{preventDefault():void})=>void))({preventDefault(){}});
  assert.equal(patches,0);
  assert.match(element('renameError').textContent,/1–120/);
  element('renameInput').value='  Renamed  ';
  (element('renameForm').onsubmit as unknown as ((e:{preventDefault():void})=>void))({preventDefault(){}});
  await flush();
  assert.equal(patches,1);
  assert.equal(sessions[0].title,'Renamed');
  assert.equal(element('renameDialog').open,false);
  assert.equal(element('title').textContent,'Renamed');

  const renamedRow=element('sessions').children[0];
  const renamedMore=renamedRow.children.find(e=>e.className==='session-more')!;
  (renamedMore.onclick as unknown as ((e:{stopPropagation():void})=>void))({stopPropagation(){}});
  element('menuDelete').onclick?.();
  assert.equal(element('deleteDialog').open,true);
  assert.equal(element('deleteName').textContent,'Renamed');
  assert.equal(deletes,0,'opening the menu/dialog must not delete');
  (element('deleteForm').onsubmit as unknown as ((e:{preventDefault():void})=>void))({preventDefault(){}});
  await flush();
  assert.equal(deletes,1);
  assert.equal(deleted,false);
  assert.equal(element('deleteDialog').open,true);
  assert.match(element('deleteError').textContent,/active or uncertain tasks/);
  blocked=false;
  (element('deleteForm').onsubmit as unknown as ((e:{preventDefault():void})=>void))({preventDefault(){}});
  await flush();
  assert.equal(deletes,2);
  assert.equal(deleted,true);
  assert.equal(element('deleteDialog').open,false);
  assert.equal(sessions.length,1);
  assert.equal(element('title').textContent,'Second');
  assert.equal(element('sessions').children.length,1);
});
