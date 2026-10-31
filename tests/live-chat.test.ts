import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store, type Conversation, type ExecutionEvent } from '../src/store.js';
import { readLiveChatEvents } from '../src/live-chat.js';
import { streamConversationEvents } from '../src/live-events.js';

const until=async(check:()=>boolean)=>{
  for(let i=0;i<100;i++){
    if(check())return;
    await new Promise<void>(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Timed out waiting for SSE events');
};

test('SSE parser handles chunk boundaries and multiple batches without duplicating text',async()=>{
  const first='event: batch\ndata: '+JSON.stringify({events:[{sequence:1,type:'delta',text:'Hello',textOffset:5}]})+'\n\n';
  const second=': heartbeat\n\nevent: batch\ndata: '+JSON.stringify({events:[{sequence:2,type:'tool',state:'completed'}]})+'\n\n';
  const payload=first+second;
  const encoder=new TextEncoder();
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      for(let i=0;i<payload.length;i+=7)controller.enqueue(encoder.encode(payload.slice(i,i+7)));
      controller.close();
    }
  });
  const events:ExecutionEvent[]=[];
  await readLiveChatEvents(new Response(stream),batch=>events.push(...batch));
  assert.deepEqual(events.map(e=>e.sequence),[1,2]);
  assert.equal(events[0].textOffset,5);
});

test('SSE replays durable events then delivers newly committed events until disconnected',async t=>{
  const store=new Store(':memory:');
  const conversationId='sse-conversation';
  const conversation:Conversation={id:conversationId,title:'Live chat',createdAt:new Date().toISOString()};
  store.save('conversations',conversation);
  store.event(conversationId,{type:'task',taskId:'task-1',state:'queued'});
  const server=createServer((req,res)=>{
    const after=Number(new URL(req.url||'/', 'http://localhost').searchParams.get('after')||0);
    streamConversationEvents(req,res,store,conversationId,after);
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const base='http://127.0.0.1:'+address.port;
  const abort=new AbortController();
  t.after(async()=>{
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    store.close();
  });
  const response=await fetch(base+'/?after=0',{signal:abort.signal});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/text\/event-stream/);
  const received:ExecutionEvent[]=[];
  const reading=readLiveChatEvents(response,events=>received.push(...events)).catch(error=>{
    if(!abort.signal.aborted)throw error;
  });
  await until(()=>received.length>=1);
  assert.equal(received[0].state,'queued');
  const delta=store.event(conversationId,{type:'delta',taskId:'task-1',state:'running',text:'Hi',textOffset:2});
  await until(()=>received.some(event=>event.sequence===delta.sequence));
  assert.equal(received.filter(event=>event.sequence===delta.sequence).length,1);
  abort.abort();
  await reading;
  // Reconnecting after the first sequence should replay only the new delta.
  const nextAbort=new AbortController();
  const next=await fetch(base+'/?after='+received[0].sequence,{signal:nextAbort.signal});
  const replayed:ExecutionEvent[]=[];
  const nextReading=readLiveChatEvents(next,events=>replayed.push(...events)).catch(error=>{
    if(!nextAbort.signal.aborted)throw error;
  });
  await until(()=>replayed.length>=1);
  assert.deepEqual(replayed.map(event=>event.sequence),[delta.sequence]);
  nextAbort.abort();
  await nextReading;
});
