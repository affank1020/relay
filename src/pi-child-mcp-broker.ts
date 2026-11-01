import { randomUUID } from 'node:crypto';
import type { SubagentsBus } from './pi-subagents-rpc.js';
import { READ_TOOLS } from './gateway.js';
import { GITHUB_READ } from './integrations/manager.js';

type RecordView={session?:{sessionManager?:{getSessionId?:()=>string}}};
export type ChildRegistry={getRecord:(id:string)=>RecordView|undefined};
export function piChildRegistry():ChildRegistry|undefined {
  const key=Symbol.for('pi-subagents:manager');
  const obj=(globalThis as unknown as Record<symbol,unknown>)[key] as ChildRegistry|undefined;
  return obj&&typeof obj.getRecord==='function'?obj:undefined;
}

interface ChildReadRequest {requestId:string;sessionId:string;tool:string;args:unknown}
export interface ChildReadResult {isError?:boolean;content?:Array<{type:string;text?:string}>}
export interface ParentReadExecutor {
  (name:string,args:unknown):Promise<ChildReadResult>;
}
export interface ChildReadGrant { agentId:string;sessionId:string;tools:ReadonlySet<string> }
const approvedReadName=(name:string):boolean => {
  if(name.startsWith('atlas_'))
    return READ_TOOLS.has(name.slice('atlas_'.length));
  const match=/^mcp__([a-z0-9_]+)__([a-zA-Z0-9_]+)$/.exec(name);
  if(!match)return false;
  const [,provider,method]=match;
  if(provider==='github')return GITHUB_READ.some(read=>read===method);
  if(provider==='atlas')return READ_TOOLS.has(method) && !method.startsWith('workspace_');
  // Operator-configured provider vocabulary is constrained to read-only
  // verbs separately by its trusted ConnectionManager schema.
  return /^(get|list|read|search|fetch|lookup|query)_[a-z0-9_]+$/.test(method);
};
const MAX_PENDING=16;
const MAX_OUTPUT=32000;
const valid=(s:unknown,max=128):s is string=>typeof s==='string'&&s.length>0&&s.length<=max;
const replyName=(id:string)=>'relay:child-mcp:reply:'+id;

/**
 * In-process capability broker for Pi's independent child sessions.
 * The child gets no credentials and only a single read proxy tool. A grant is
 * bound to a real upstream agent's SDK session ID, not a model-supplied id.
 * Root ctx.executeTool routes via Pi's already-registered MCP tool, retaining
 * Relay's live provider checks and existing native MCP invocation receipts.
 */
export class PiChildMcpBroker {
  private grants=new Map<string,ChildReadGrant>();
  private pending=new Set<string>();
  private closed=false;
  private completedReads=0;
  private unsubscribe:()=>void;
  get verifiedReadCount():number{return this.completedReads;}
  constructor(private bus:SubagentsBus,private rootSignal:AbortSignal,
    private readonly execute:ParentReadExecutor,
    private readonly onReceipt?:(agentId:string,tool:string,success:boolean)=>void) {
    this.unsubscribe=bus.on('relay:child-mcp:read',raw=>{void this.read(raw);});
  }
  bind(agentId:string,allowed:readonly string[],registry=piChildRegistry()):boolean {
    if(this.closed||this.rootSignal.aborted||!registry||!valid(agentId))return false;
    const actual=registry.getRecord(agentId)?.session?.sessionManager?.getSessionId?.();
    if(!valid(actual,256)||!allowed.length||allowed.some(name=>!approvedReadName(name)))
      return false;
    if([...this.grants.values()].some(g=>g.agentId===agentId||g.sessionId===actual))return false;
    this.grants.set(actual,{agentId,sessionId:actual,tools:new Set(allowed)});
    return true;
  }
  async bindWhenReady(agentId:string,allowed:readonly string[],registry=piChildRegistry()):Promise<boolean> {
    for(let attempt=0;attempt<200&&!this.closed&&!this.rootSignal.aborted;attempt++){
      if(this.bind(agentId,allowed,registry))return true;
      // The upstream started event can precede SDK child session creation,
      // especially with local Ollama startup. Allow bounded initialization.
      await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    return false;
  }
  revoke(agentId:string):void {
    for(const [sessionId,g] of this.grants)if(g.agentId===agentId)this.grants.delete(sessionId);
  }
  close():void {
    if(this.closed)return;
    this.closed=true;this.unsubscribe();this.grants.clear();this.pending.clear();
  }
  private async read(raw:unknown):Promise<void> {
    if(typeof raw!=='object'||raw===null)return;
    const req=raw as Partial<ChildReadRequest>;
    if(!valid(req.requestId,128)||!valid(req.sessionId,256))return;
    const respond=(success:boolean,text:string)=>this.bus.emit(replyName(req.requestId!),{
      success,text:text.slice(0,MAX_OUTPUT)
    });
    if(this.closed||this.rootSignal.aborted){respond(false,'Parent task no longer running');return;}
    const grant=this.grants.get(req.sessionId);
    // Multiple Pi children share one in-process bus. A broker must never
    // answer a request belonging to a different child, otherwise its denial
    // races the real owner's successful read and corrupts parallel research.
    // Unbound child requests fail closed via the child proxy's timeout.
    if(!grant)return;
    if(!valid(req.tool,180)||!grant.tools.has(req.tool)){
      respond(false,'Child MCP read not authorised');return;
    }
    if(this.pending.size>=MAX_PENDING||this.pending.has(req.requestId)){
      respond(false,'Child MCP invocation limit reached');return;
    }
    if(typeof req.args!=='object'||req.args===null||Array.isArray(req.args)||
        JSON.stringify(req.args).length>12000){
      respond(false,'Invalid child MCP arguments');return;
    }
    this.pending.add(req.requestId);
    try {
      const result=await this.execute(req.tool,req.args);
      if(this.closed||this.rootSignal.aborted||this.grants.get(req.sessionId)!==grant){
        respond(false,'Child MCP authority revoked during invocation');return;
      }
      if(result.isError){
        this.onReceipt?.(grant.agentId,req.tool,false);
        respond(false,'GitHub/Atlas read failed; no issue content retrieved');return;
      }
      const texts=(result.content??[]).filter(c=>c.type==='text'&&typeof c.text==='string')
        .map(c=>c.text!).join('\n');
      // A transport-level success with no source body is not research
      // evidence. Do not count it as a verified read or tell the child that
      // content was retrieved. This caught the nested outcome-shape defect.
      if(!texts.trim()){
        this.onReceipt?.(grant.agentId,req.tool,false);
        respond(false,'MCP read returned no source content');return;
      }
      this.completedReads++;
      this.onReceipt?.(grant.agentId,req.tool,true);
      respond(true,texts);
    }catch{
      this.onReceipt?.(grant.agentId,req.tool,false);
      respond(false,'MCP read failed; no verified result available');
    }finally{this.pending.delete(req.requestId);}
  }
}
