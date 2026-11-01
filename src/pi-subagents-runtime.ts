import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import type { SubagentsBus, SubagentTransition } from './pi-subagents-rpc.js';
import { PiSubagentsRpc } from './pi-subagents-rpc.js';
import { PiChildMcpBroker } from './pi-child-mcp-broker.js';
import { piSubagentsEnabled,piChildMcpEnabled } from './pi-mode.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';

// Explicit, opt-in operator mode. Never install or discover arbitrary Pi
// extensions from untrusted projects or from a user's chat prompt.
export function piSubagentEnabled(task:{parentId:string|null;delegation?:unknown}):boolean {
  return piSubagentsEnabled() && !task.parentId && !task.delegation;
}
/** Upstream tools must not bypass Relay's audited bridge. This list is not
 * the security boundary: the live tool_call hook blocks every other name. */
export const upstreamSubagentTools=['Agent','SubagentWorkflow','get_subagent_result',
  'steer_subagent'] as const;
export function verifyPiSubagentsPolicy(projectRoot=process.cwd()):void {
  const file=readFileSync(join(projectRoot,'.pi','agents','relay-isolated.md'),'utf8');
  const settings=JSON.parse(readFileSync(join(projectRoot,'.pi','subagents.json'),'utf8')) as Record<string,unknown>;
  for(const required of ['name: relay-isolated','tools: read',
    'disallowed_tools: read, bash, powershell, write, edit, grep, find, ls',
    'extensions: false','skills: false','isolated: true'])
    if(!file.split(/\r?\n/).includes(required))
      throw new Error('Reviewed Pi subagent capability policy missing or changed');
  if(piChildMcpEnabled()){
    const child=readFileSync(join(projectRoot,'.pi','agents','relay-research.md'),'utf8');
    for(const required of ['name: relay-research',
      'tools: ext:pi-child-mcp-extension/relay_child_mcp_read',
      'disallowed_tools: read, bash, powershell, write, edit, grep, find, ls',
      'extensions: [/app/dist/pi-child-mcp-extension.js]',
      'skills: false','isolated: false','persist_session: false'])
      if(!child.split(/\r?\n/).includes(required))
        throw new Error('Reviewed Pi child MCP policy missing or changed');
  }
  if(settings.disableDefaultAgents!==true||settings.fallbackSubagent!=='none'||
      settings.schedulingEnabled!==false||settings.strictAgentFiles!==true)
    throw new Error('Pi subagent fail-closed runtime settings are missing or changed');
}
export function pinnedSubagentsExtension():string {
  verifyPiSubagentsPolicy();
  const require=createRequire(import.meta.url);
  let manifest:string;
  try {manifest=require.resolve('@tintinweb/pi-subagents/package.json');}
  catch {throw new Error('Pinned Pi subagents package is not installed; experimental delegation refused');}
  const pkg=require(manifest) as {name?:string;version?:string};
  if(pkg.name!=='@tintinweb/pi-subagents'||pkg.version!=='0.22.1')
    throw new Error('Pi subagents package version does not match reviewed pin 0.22.1');
  return join(dirname(manifest),'src','index.ts');
}
export interface PiSubagentRuntime {
  tool:ToolDefinition;
  extensionFactory:(pi:{events:SubagentsBus})=>void;
}
export interface PiChildUsage {
  agentId:string;
  usage:{input:number;output:number;cacheRead:number;cacheWrite:number;
    costUsd:number|null};
}
export function piSubagentRuntime(signal:AbortSignal,
  onTransition?:(event:SubagentTransition)=>void,
  allowedReadNames:readonly string[]=[],
  onReadReceipt?:(agentId:string,tool:string,success:boolean)=>void,
  onChildUsage?:(usage:PiChildUsage)=>void):PiSubagentRuntime {
  let rpc:PiSubagentsRpc|undefined;
  let bus:SubagentsBus|undefined;
  return {
    extensionFactory:pi=>{bus=pi.events;rpc=new PiSubagentsRpc(pi.events);},
    tool:{
      name:'relay_pi_delegate',label:'Pi subagent',
      description:'Delegate bounded work through Pi subagents. For real GitHub/Atlas research, select exact permitted read-only MCP tool names; the child cannot access anything else.',
      parameters:Type.Object({
        prompt:Type.String({minLength:1,maxLength:6000}),
        tools:Type.Optional(Type.Array(Type.String(),{maxItems:4}))
      }),
      execute:async (_id,input,ctxSignal,_update,ctx)=>{
        if(!rpc||!bus||!(await rpc.available(signal)))
          throw new Error('Pi subagents extension RPC unavailable; no child was spawned');
        const args=input as {prompt:string;tools?:string[]};
        const requested=args.tools??[];
        if(requested.length!==new Set(requested).size ||
            requested.some(name=>!allowedReadNames.includes(name)))
          throw new Error('Requested child MCP tool is not authorised for this run');
        if(requested.length&&!piChildMcpEnabled())
          throw new Error('Child MCP broker is not enabled on this Relay server');
        const broker=requested.length?new PiChildMcpBroker(bus,signal,
          async (name,params)=>{
            // Nested Pi tool calls preserve native provider revocation, approval
            // and audit guards; no child credentials or duplicate transport.
            const result=await ctx.executeTool(name,params);
            return result as {isError?:boolean;content?:Array<{type:string;text?:string}>};
          },(agentId,tool,success)=>onReadReceipt?.(agentId,tool,success)):undefined;
        // Observe usage only for the lifetime of this delegated call. A
        // process-level Pi bus can outlive a single root task; never leak
        // its budget callback into another conversation.
        const unlistenUsage=onChildUsage?bus.on('subagents:usage',value=>{
          if(!value||typeof value!=='object')return;
          const raw=value as {id?:unknown;usage?:Record<string,unknown>};
          if(typeof raw.id!=='string'||!raw.usage)return;
          const u=raw.usage;
          const safe=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9?v:null;
          const input=safe(u.input),output=safe(u.output);
          const cacheRead=safe(u.cacheRead),cacheWrite=safe(u.cacheWrite);
          const cost=u.cost&&typeof u.cost==='object'
            ?safe((u.cost as Record<string,unknown>).total):null;
          if(input===null||output===null||cacheRead===null||cacheWrite===null)return;
          onChildUsage({agentId:raw.id,usage:{input,output,cacheRead,cacheWrite,costUsd:cost}});
        }):()=>{};
        let binding:Promise<boolean>|undefined;
        try{
          const result=await rpc.run({prompt:args.prompt,
            type:requested.length?'relay-research':'relay-isolated',
            signal:ctxSignal??signal,maxTurns:12,maxRunMs:60000,
            onTransition:event=>{
              onTransition?.(event);
              if(event.status==='started'&&broker)
                binding=broker.bindWhenReady(event.agentId,requested);
              if(event.status!=='started')broker?.revoke(event.agentId);
            }});
          if(requested.length&&(!binding||!(await binding)))
            throw new Error('Child research MCP authorization could not be bound to its Pi session');
          if(requested.length&&(!broker||broker.verifiedReadCount===0))
            throw new Error('Child research completed without a successful authorised MCP read; cannot report verified source findings');
          return {content:[{type:'text' as const,text:JSON.stringify({
            agentId:result.agentId,result:result.result,
            sourceTools:requested,verifiedExternalSources:!!broker?.verifiedReadCount
          })}],details:{}};
        }finally{broker?.close();unlistenUsage();}
      }
    }
  };
}
