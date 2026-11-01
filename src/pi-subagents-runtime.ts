import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import type { SubagentsBus, SubagentTransition } from './pi-subagents-rpc.js';
import { PiSubagentsRpc } from './pi-subagents-rpc.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';

// Explicit, opt-in operator mode. Never install or discover arbitrary Pi
// extensions from untrusted projects or from a user's chat prompt.
export function piSubagentEnabled(task:{parentId:string|null;delegation?:unknown}):boolean {
  return process.env.RELAY_PI_SUBAGENTS==='1' && !task.parentId && !task.delegation;
}
export function pinnedSubagentsExtension():string {
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
export function piSubagentRuntime(signal:AbortSignal,
  onTransition?:(event:SubagentTransition)=>void):PiSubagentRuntime {
  let rpc:PiSubagentsRpc|undefined;
  return {
    extensionFactory:pi=>{rpc=new PiSubagentsRpc(pi.events);},
    tool:{
      name:'relay_pi_delegate',label:'Pi subagent',
      description:'Delegate a bounded, tool-less analysis task to the installed Pi subagents extension. The child has no GitHub, Atlas, shell or filesystem tools. Do not use this for independent research requiring live sources.',
      parameters:Type.Object({prompt:Type.String({minLength:1,maxLength:6000})}),
      execute:async (_id,input)=>{
        if(!rpc||!(await rpc.available(signal)))
          throw new Error('Pi subagents extension RPC is unavailable; no child was spawned');
        const result=await rpc.run({prompt:(input as {prompt:string}).prompt,
          type:'relay-isolated',signal,maxTurns:12,maxRunMs:60000,onTransition});
        return {content:[{type:'text' as const,text:JSON.stringify({
          agentId:result.agentId,result:result.result,verifiedExternalSources:false
        })}],details:{}};
      }
    }
  };
}
