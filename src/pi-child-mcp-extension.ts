import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// A reviewed child-only extension. It has no tokens, transport or credential
// discovery. The parent must bind the child session to a grant before its first
// read; an unbound child always receives an explicit denial.
export default function relayChildMcp(pi:ExtensionAPI):void {
  pi.registerTool({
    name:'relay_child_mcp_read',label:'Read authorised MCP source',
    description:'Read an explicitly authorised GitHub/Atlas source. Tools and permissions are decided by the parent. Never claim source access on denial.',
    parameters:Type.Object({
      tool:Type.String({description:'Exact authorised tool name, e.g. mcp__github__issue_read'}),
      args:Type.Record(Type.String(),Type.Any())
    }),
    execute:async (_callId,input,signal,_update,ctx)=>{
      const data=input as {tool:string;args:Record<string,unknown>};
      const sessionId=ctx.sessionManager.getSessionId();
      const id=randomUUID();
      const response=await new Promise<{success:boolean;text:string}>((resolve)=>{
        let done=false;
        let timer:ReturnType<typeof setTimeout>|undefined;
        const stop=(success:boolean,text:string)=>{
          if(done)return;done=true;
          if(timer)clearTimeout(timer);
          unsubscribe();signal?.removeEventListener('abort',onAbort);
          resolve({success,text});
        };
        const onAbort=()=>stop(false,'Child read cancelled');
        const unsubscribe=pi.events.on('relay:child-mcp:reply:'+id,data=>{
          const reply=data as {success?:boolean;text?:string};
          stop(reply?.success===true,typeof reply?.text==='string'?reply.text:'No verified MCP result');
        });
        timer=setTimeout(()=>stop(false,'Child MCP broker unavailable or not authorised'),12000);
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        else pi.events.emit('relay:child-mcp:read',{
          requestId:id,sessionId,tool:data.tool,args:data.args
        });
      });
      return {content:[{type:'text' as const,text:response.success?response.text:
        'MCP READ FAILED: '+response.text+'. Do not infer source contents.'}],details:{
          verified:response.success
        }};
    }
  });
}
