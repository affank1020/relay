import type { ExecutionEvent } from './store.js';

// Fetch streaming works for both the HTTPS Basic Auth deployment and the
// localhost bearer-token mode; native EventSource cannot set the latter header.
export async function readLiveChatEvents(
  response:Response,
  onBatch:(events:ExecutionEvent[])=>void
):Promise<void> {
  if(!response.body)throw new Error('Streaming response has no body');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let pending='';
  try {
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      pending+=decoder.decode(value,{stream:true});
      if(pending.length>4_000_000)throw new Error('Oversized event stream frame');
      let boundary:number;
      while((boundary=pending.indexOf('\n\n'))!==-1){
        const frame=pending.slice(0,boundary);
        pending=pending.slice(boundary+2);
        const lines=frame.split('\n');
        if(!lines.includes('event: batch'))continue;
        const payload=lines.filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');
        const value:unknown=JSON.parse(payload);
        if(!value||typeof value!=='object'||!('events' in value)||!Array.isArray(value.events))
          throw new Error('Invalid stream event batch');
        // Limit the browser's per-frame work; preserve backend event ordering.
        if(value.events.length>64)throw new Error('Oversized stream event batch');
        onBatch(value.events as ExecutionEvent[]);
      }
    }
  }finally{
    // Closing the reader also releases the socket after a session switch.
    reader.releaseLock();
  }
}
