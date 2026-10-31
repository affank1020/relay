import assert from 'node:assert/strict';
import {test} from 'node:test';
import { renderAtlasAwarenessRow,refreshAtlasAwarenessRows, type AtlasAwarenessRow } from '../src/atlas-awareness-render.js';
import type { AtlasAwarenessEvent, AtlasCheckoutView } from '../src/atlas-awareness.js';
import type { AtlasDetailView } from '../src/atlas-awareness-details.js';

class FakeElement {
  children:FakeElement[]=[];
  hidden=false;
  className='';
  textContent='';
  href='';
  target='';
  rel='';
  constructor(readonly tag='div'){}
  append(...children:FakeElement[]){this.children.push(...children);}
  replaceChildren(...children:FakeElement[]){this.children=[...children];}
  get childElementCount(){return this.children.length;}
  links():string[]{
    return [...(this.tag==='a'?[this.href]:[]),...this.children.flatMap(c=>c.links())];
  }
  texts():string[]{
    return [this.textContent,...this.children.flatMap(c=>c.texts())];
  }
}
const project='008b191b-96c2-4a5f-92f6-1f13d6d790d5';
const checkout='59c7c5ad-a3c0-4667-913d-66285303ea51';
const taskId='task-a';
const originA='https://atlas-one.example.com';
const originB='https://atlas-two.example.com';

test('configured Atlas web origin changes update existing cards without new observations',()=>{
  const globalDocument=globalThis as unknown as {document:unknown};
  const prior=globalDocument.document;
  globalDocument.document={createElement:(tag:string)=>new FakeElement(tag)};
  try{
    const container=new FakeElement();
    const row:AtlasAwarenessRow={awareness:container as unknown as HTMLElement,awarenessKey:''};
    const rows=new Map([[taskId,row]]);
    const observation:AtlasAwarenessEvent={
      id:'obs-1',sequence:1,timestamp:'2026-10-31T21:00:00Z',
      conversationId:'chat-a',taskId,agentRunId:'run-a',invocationId:'read-a',
      type:'atlas_resource',state:'completed',tool:'get_workspace',workspaceId:checkout,
      atlasResource:{
        schemaVersion:1,providerId:'atlas',toolName:'get_workspace',evidenceSource:'response',
        resources:[{type:'checkout',id:checkout},{type:'project',id:project}],
        checkout:{id:checkout,projectId:project,name:'Test checkout',status:'active'}
      }
    };
    // The first render predates an operator configuring the origin.
    refreshAtlasAwarenessRows(rows,[observation],undefined,Date.parse('2026-10-31T21:02:00Z'));
    assert.deepEqual(container.links(),[]);
    assert.ok(container.texts().includes('Test checkout'));
    const initialCard=container.children[0];
    const initialKey=row.awarenessKey;
    assert.ok(initialCard);

    // The same mounted message row must immediately receive links when /status
    // changes; no additional Atlas events or conversation snapshot are needed.
    refreshAtlasAwarenessRows(rows,[observation],originA,Date.parse('2026-10-31T21:02:00Z'));
    assert.notEqual(row.awarenessKey,initialKey);
    assert.deepEqual(container.links(),[originA+'/#/projects/'+project+'/workspaces']);
    const cardA=container.children[0];
    assert.notEqual(cardA,initialCard);
    assert.equal(rows.get(taskId),row,'the chat row is retained');

    // An unchanged origin/evidence must keep current DOM and expanded state.
    refreshAtlasAwarenessRows(rows,[observation],originA,Date.parse('2026-10-31T21:02:05Z'));
    assert.equal(container.children[0],cardA);

    refreshAtlasAwarenessRows(rows,[observation],originB,Date.parse('2026-10-31T21:02:05Z'));
    assert.deepEqual(container.links(),[originB+'/#/projects/'+project+'/workspaces']);
    assert.equal(container.links().some(href=>href.startsWith(originA)),false);

    refreshAtlasAwarenessRows(rows,[observation],undefined,Date.parse('2026-10-31T21:02:05Z'));
    assert.deepEqual(container.links(),[],'removing the origin also removes old links');
    assert.ok(container.texts().includes('Test checkout'));
  }finally{globalDocument.document=prior;}
});

test('keyed Atlas details refresh links only for the matching task and preserve non-Atlas chat',()=>{
  const globalDocument=globalThis as unknown as {document:unknown};
  const prior=globalDocument.document;
  globalDocument.document={createElement:(tag:string)=>new FakeElement(tag)};
  try{
    const withDetail=new FakeElement(),withoutDetail=new FakeElement();
    const detail:AtlasDetailView={taskId,observedAt:'2026-10-31T21:00:00Z',
      detail:{kind:'project',projectId:project,label:'Atlas project'},
      resources:[{type:'project',id:project}]};
    const first:AtlasAwarenessRow={awareness:withDetail as unknown as HTMLElement,awarenessKey:''};
    const second:AtlasAwarenessRow={awareness:withoutDetail as unknown as HTMLElement,awarenessKey:''};
    const noCheckout:AtlasCheckoutView[]=[];
    assert.equal(renderAtlasAwarenessRow(first,taskId,noCheckout,[detail],originA),true);
    assert.equal(renderAtlasAwarenessRow(second,'unrelated-task',noCheckout,[detail],originA),true);
    assert.deepEqual(withDetail.links(),[originA+'/#/projects/'+project]);
    assert.equal(withoutDetail.children.length,0,'ordinary chat must not show Atlas cards');
    const card=withDetail.children[0];
    assert.equal(renderAtlasAwarenessRow(first,taskId,noCheckout,[detail],originA),false);
    assert.equal(withDetail.children[0],card);
    assert.equal(renderAtlasAwarenessRow(first,taskId,noCheckout,[detail],originB),true);
    assert.deepEqual(withDetail.links(),[originB+'/#/projects/'+project]);
    assert.equal(withDetail.links().some(href=>href.includes('atlas-one')),false);
  }finally{globalDocument.document=prior;}
});
