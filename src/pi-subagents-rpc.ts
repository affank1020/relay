import { randomUUID } from 'node:crypto';

// pi-subagents v0.22.x public in-process RPC protocol. This does not load
// third-party code or grant it host credentials. Only a controlled host may
// install the package and feed its event bus into this adapter.
export interface SubagentsBus {
  on(event:string,listener:(data:unknown)=>void):()=>void;
  emit(event:string,data:unknown):void;
}
export interface SubagentTransition {
  agentId:string;
  status:'started'|'completed'|'failed'|'stopped';
  result?:string;
  error?:string;
}
export interface SubagentRunOptions {
  prompt:string;
  type:'relay-isolated'|'relay-research';
  signal:AbortSignal;
  maxTurns?:number;
  maxRunMs?:number;
  onTransition?:(event:SubagentTransition)=>void;
}
type Envelope={success:boolean;data?:unknown;error?:string};
const object=(value:unknown):value is Record<string,unknown> =>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
function envelope(value:unknown):Envelope {
  if(!object(value)||typeof value.success!=='boolean')throw Error('Malformed Pi subagent RPC reply');
  return value as Envelope;
}
function boundedInt(input:number|undefined,fallback:number,max:number,label:string):number {
  const value=input??fallback;
  if(!Number.isInteger(value)||value<1||value>max)throw Error('Invalid '+label);
  return value;
}

/**
 * A strictly isolated, tool-less first bridge. The named upstream agent type
 * must be reviewed and defined separately; this adapter cannot authorize
 * GitHub/Atlas reads inside its independent Pi child session. Those calls
 * require a dedicated child-side capability broker in a later migration.
 */
export class PiSubagentsRpc {
  constructor(private bus:SubagentsBus,private requestTimeoutMs=3000) {
    boundedInt(requestTimeoutMs,3000,30000,'RPC timeout');
  }
  private rpc(kind:'ping'|'spawn'|'stop'|'consume',body:Record<string,unknown>,
    signal?:AbortSignal):Promise<unknown> {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new Error('Pi subagent request cancelled'));return;}
      const id=randomUUID();
      const replyName='subagents:rpc:'+kind+':reply:'+id;
      let finished=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const settle=(err?:Error,result?:unknown)=>{
        if(finished)return;finished=true;
        if(timer)clearTimeout(timer);remove();signal?.removeEventListener('abort',abort);
        if(err)reject(err);else resolve(result);
      };
      const remove=this.bus.on(replyName,data=>{
        try{const parsed=envelope(data);
          if(!parsed.success)settle(new Error(parsed.error||'Pi subagent request rejected'));
          else settle(undefined,parsed.data);
        }catch(error){settle(error as Error);}
      });
      const abort=()=>settle(new Error('Pi subagent request cancelled'));
      timer=setTimeout(()=>settle(new Error(kind==='spawn'
        ?'Pi subagent spawn outcome uncertain; reconcile before retry'
        :'Pi subagent RPC unavailable or timed out')),this.requestTimeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      try{this.bus.emit('subagents:rpc:'+kind,{requestId:id,...body});}
      catch(error){settle(error as Error);}
    });
  }
  async available(signal?:AbortSignal):Promise<boolean> {
    try{const result=await this.rpc('ping',{},signal);
      return object(result)&&result.version===2;
    }catch{return false;}
  }
  async stop(agentId:string):Promise<void>{
    if(!agentId||agentId.length>256)throw Error('Invalid subagent identity');
    await this.rpc('stop',{agentId});
  }
  async run(options:SubagentRunOptions):Promise<{agentId:string;result:string}> {
    const prompt=options.prompt.trim();
    if(!prompt||prompt.length>6000||!['relay-isolated','relay-research'].includes(options.type))
      throw Error('Invalid isolated subagent request');
    const maxTurns=boundedInt(options.maxTurns,12,32,'subagent turns');
    const maxRunMs=boundedInt(options.maxRunMs,60000,300000,'subagent duration');
    if(options.signal.aborted)throw Error('Pi subagent request cancelled');
    const terminal=new Map<string,SubagentTransition>();
    let agentId:string|undefined,settled=false;
    let resolveRun!:(value:{agentId:string;result:string})=>void;
    let rejectRun!:(reason:Error)=>void;
    const completion=new Promise<{agentId:string;result:string}>((resolve,reject)=>{
      resolveRun=resolve;rejectRun=reject;
    });
    // A provider can reject spawn before we begin awaiting completion.
    // Mark its failure handled even across cancellation/startup races.
    void completion.catch(()=>{});
    const finish=(event:SubagentTransition)=>{
      if(settled||!agentId||event.agentId!==agentId)return;
      if(event.status==='started'){options.onTransition?.(event);return;}
      settled=true;options.onTransition?.(event);
      if(event.status==='completed'&&typeof event.result==='string'){
        // Consume synchronously on the completion event to prevent the
        // extension's second, redundant parent notification/agent turn.
        this.bus.emit('subagents:rpc:consume',{requestId:randomUUID(),agentId});
        resolveRun({agentId,result:event.result});
      }
      else rejectRun(new Error(event.error||'Pi subagent failed without verified result'));
    };
    const readEvent=(state:SubagentTransition['status'])=>(raw:unknown)=>{
      if(!object(raw)||typeof raw.id!=='string')return;
      const event:SubagentTransition={agentId:raw.id,status:state,
        ...(typeof raw.result==='string'?{result:raw.result}:{}),
        ...(typeof raw.error==='string'?{error:raw.error}:{})};
      if(!agentId)terminal.set(raw.id,event);
      else finish(event);
    };
    const remove=[
      this.bus.on('subagents:started',readEvent('started')),
      this.bus.on('subagents:completed',readEvent('completed')),
      this.bus.on('subagents:failed',readEvent('failed'))
    ];
    const abort=()=>{
      if(settled)return;
      settled=true;
      if(agentId){
        options.onTransition?.({agentId,status:'stopped',error:'Cancelled'});
        void this.stop(agentId).catch(()=>{});
      }
      rejectRun(new Error('Pi subagent cancelled'));
    };
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      if(agentId){
        options.onTransition?.({agentId,status:'stopped',error:'Time budget exceeded'});
        void this.stop(agentId).catch(()=>{});
      }
      rejectRun(new Error('Pi subagent time budget exceeded'));
    },maxRunMs);
    options.signal.addEventListener('abort',abort,{once:true});
    try{
      // This RPC's isolated flag strips extensions and Skills. An operator
      // must additionally supply a reviewed "relay-isolated" agent definition
      // with ALL builtin shell/filesystem tools denied.
      const reply=await this.rpc('spawn',{type:options.type,prompt,
        options:{isolated:options.type==='relay-isolated',inheritContext:false,isBackground:true,
          maxTurns,description:options.type==='relay-research'
            ?'Relay scoped read-only research task':'Relay isolated delegated task'}});
      if(!object(reply)||typeof reply.id!=='string'||!reply.id)
        throw Error('Pi subagent RPC did not return an agent ID');
      agentId=reply.id;
      if(terminal.has(agentId))finish(terminal.get(agentId)!);
      // Cancellation may precede the spawn reply. Once Pi finally supplies
      // the ID, stop that potentially-running orphan even though the caller
      // has already received a rejected cancellation promise.
      if(options.signal.aborted&&settled){
        options.onTransition?.({agentId,status:'stopped',error:'Cancelled before spawn acknowledgement'});
        void this.stop(agentId).catch(()=>{});
      }else if(options.signal.aborted)abort();
      return await completion;
    }finally{
      clearTimeout(timer);options.signal.removeEventListener('abort',abort);
      for(const unsubscribe of remove)unsubscribe();
    }
  }
}
