import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.js';

// Live chat is an authenticated, read-only SSE stream backed by the same
// durable sequence numbers as GET /sessions/:id/events. Subscriptions are
// wake-up hints; each frame contains only committed, replayable events.
export function streamConversationEvents(
  req:IncomingMessage,res:ServerResponse,store:Store,conversationId:string,after:number
):void {
  res.writeHead(200,{
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-cache, no-transform',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no',
  });
  let cursor=after,closed=false,blocked=false,sending=false,queued=false;
  let unsubscribe=()=>{};
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  function close(){
    if(closed)return;
    closed=true;
    unsubscribe();
    if(heartbeat)clearInterval(heartbeat);
    if(!res.writableEnded)res.end();
  }
  function drained(){
    if(closed)return;
    blocked=false;
    flush();
  }
  function write(frame:string):boolean{
    if(closed)return false;
    if(!res.write(frame)){
      blocked=true;
      res.once('drain',drained);
      return false;
    }
    return true;
  }
  function flush(){
    if(closed||blocked||sending){queued=true;return;}
    sending=true;
    try {
      // Send bounded batches; stop immediately on backpressure. We never keep
      // an unbounded per-client queue in RAM, only the durable SQLite cursor.
      let batches=0;
      while(!closed&&!blocked&&batches++<16){
        const events=store.events(conversationId,cursor).slice(0,64);
        if(!events.length)break;
        cursor=events[events.length-1].sequence;
        const frame='id: '+cursor+'\nevent: batch\ndata: '+JSON.stringify({events})+'\n\n';
        if(!write(frame))break;
        if(events.length<64)break;
      }
      if(batches>=16&&!blocked)queued=true;
    }catch{
      close();
    }finally{
      sending=false;
      if(queued&&!closed&&!blocked){
        queued=false;
        queueMicrotask(flush);
      }
    }
  }
  req.on('close',close);
  res.on('close',close);
  unsubscribe=store.subscribeEvents(conversationId,flush);
  heartbeat=setInterval(()=>{
    if(closed||blocked)return;
    write(': heartbeat\n\n');
  },15000);
  // Force response headers through proxies before any model output arrives.
  write(': connected\n\n');
  flush();
}
