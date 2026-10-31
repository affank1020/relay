import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AtlasContextPicker } from '../src/atlas-picker.js';

const projectId='f81b5f68-5a1b-414f-949d-9af62977387d';
const checkoutId='df1c2c81-1383-4533-92ed-b512dbd5646b';
const logicalWorkspaceId='4d2c2103-360b-4913-8240-f9767de1bd48';
const project={id:projectId,name:'Atlas'};
const checkout={checkoutId,name:'Atlas Mac',projectId,logicalWorkspaceId,nodeId:null};
class FakeElement {
  children:FakeElement[]=[];
  attributes=new Map<string,string>();
  className='';textContent='';value='';title='';type='';hidden=false;disabled=false;
  onclick?:()=>void; onchange?:()=>void;
  constructor(readonly tag:string){}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  append(...nodes:FakeElement[]){
    this.children.push(...nodes);
    if(this.tag==='select'&&this.children.length===nodes.length&&nodes.length)this.value=nodes[0].value;
  }
  replaceChildren(...nodes:FakeElement[]){this.children=[];this.value='';this.append(...nodes);}
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise<void>(r=>setImmediate(r));};
function setup(api:(path:string,init?:RequestInit)=>Promise<Response>){
  const original=globalThis.document;
  (globalThis as {document?:Document}).document={createElement:(tag:string)=>new FakeElement(tag)} as unknown as Document;
  const root=new FakeElement('div'), errors:unknown[]=[];
  const picker=new AtlasContextPicker(root as unknown as HTMLElement,api,error=>errors.push(error));
  const trigger=root.children[0],panel=root.children[1];
  const projectSelect=panel.children[0].children[0].children[0];
  const checkoutSelect=panel.children[1].children[0].children[0];
  const save=panel.children[3].children[1];
  return {picker,root,trigger,panel,projectSelect,checkoutSelect,save,errors,cleanup(){
    (globalThis as {document?:Document}).document=original;
  }};
}
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200});

test('picker loads authenticated resource lists, saves IDs, and restores per-chat names',async()=>{
  const calls:Array<{path:string;body?:string}>=[];
  const ui=setup(async(path,init)=>{
    calls.push({path,body:init?.body as string|undefined});
    if(path==='/atlas/context/projects')return response({projects:[project]});
    if(path==='/atlas/context/projects/'+projectId+'/checkouts')return response({checkouts:[checkout]});
    if(path==='/sessions/a/context'){
      assert.equal(init?.method,'PATCH');
      assert.deepEqual(JSON.parse(String(init.body)),{projectId,checkoutId});
      return response({session:{id:'a',busy:false,atlasContext:{projectId,projectName:'Atlas',checkoutId,checkoutName:'Atlas Mac',logicalWorkspaceId,nodeId:null}}});
    }
    throw Error('Unexpected API '+path);
  });
  try {
    ui.picker.setSession({id:'a',busy:false,atlasContext:null});
    assert.equal(ui.trigger.textContent,'No project');
    ui.trigger.onclick?.();await settle();
    assert.equal(ui.projectSelect.children.length,2);
    ui.projectSelect.value=projectId;ui.projectSelect.onchange?.();await settle();
    assert.equal(ui.checkoutSelect.children.length,2);
    assert.match(ui.checkoutSelect.children[1].textContent,/Workspace /);
    ui.checkoutSelect.value=checkoutId;ui.checkoutSelect.onchange?.();
    assert.equal(ui.save.disabled,false);
    ui.save.onclick?.();await settle();
    assert.equal(ui.panel.hidden,true);
    assert.equal(ui.trigger.textContent,'Atlas / Atlas Mac');
    assert.equal(calls.filter(c=>c.path==='/sessions/a/context').length,1);
    ui.picker.setSession({id:'b',busy:false,atlasContext:null});
    assert.equal(ui.trigger.textContent,'No project');
    ui.picker.setSession({id:'a',busy:false,atlasContext:{projectId,projectName:'Atlas',checkoutId,checkoutName:'Atlas Mac',logicalWorkspaceId,nodeId:null}});
    assert.equal(ui.trigger.textContent,'Atlas / Atlas Mac');
    assert.deepEqual(ui.errors,[]);
  } finally {ui.cleanup();}
});

test('picker preserves a missing checkout as unavailable and rejects active-task edits',async()=>{
  const ui=setup(async path=>{
    if(path==='/atlas/context/projects')return response({projects:[project]});
    if(path==='/atlas/context/projects/'+projectId+'/checkouts')return response({checkouts:[]});
    throw Error('Unexpected API '+path);
  });
  const persisted={projectId,projectName:'Atlas',checkoutId,checkoutName:'Old checkout',logicalWorkspaceId,nodeId:null};
  try{
    ui.picker.setSession({id:'a',busy:false,atlasContext:persisted});
    ui.trigger.onclick?.();await settle();
    assert.equal(ui.checkoutSelect.children.length,2);
    assert.equal(ui.checkoutSelect.children[1].disabled,true);
    assert.equal(ui.save.disabled,true,'stale checkout cannot be silently revalidated');
    ui.checkoutSelect.value='';ui.checkoutSelect.onchange?.();
    assert.equal(ui.save.disabled,false,'user may explicitly clear a stale checkout');
    ui.picker.setSession({id:'a',busy:true,atlasContext:persisted});
    assert.equal(ui.save.disabled,true);
  }finally{ui.cleanup();}
});

test('switching conversation drops an in-flight Atlas discovery response',async()=>{
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const ui=setup(async()=>{await held;return response({projects:[project]});});
  try {
    ui.picker.setSession({id:'a',busy:false,atlasContext:null});
    ui.trigger.onclick?.();
    ui.picker.setSession({id:'b',busy:false,atlasContext:null});
    assert.equal(ui.panel.hidden,true);
    release();await settle();
    assert.equal(ui.panel.hidden,true);
    assert.equal(ui.trigger.textContent,'No project');
  } finally{release();ui.cleanup();}
});
