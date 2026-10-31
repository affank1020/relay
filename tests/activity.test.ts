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
  onclick?:()=>void;
  onsubmit?:()=>void;
  onkeydown?:()=>void;
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
  showModal(){}
  close(){}
  setAttribute(_name:string,_value:string){}
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

  const second=element('sessions').children[1];
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
