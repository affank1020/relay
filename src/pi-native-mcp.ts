import { createHash, randomUUID } from 'node:crypto';
import type { LoadedMcpConfig } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Store, Task, InvocationRecord } from './store.js';
import type { ProviderConfig } from './integrations/manager.js';

// Pi's own MCP transport/discovery owns connections and tool definitions.
// Relay owns just admission and durable event attribution. Never load ambient
// mcp.json, project resources or arbitrary tools in this server process.
export interface NativeMcpProvider { config:ProviderConfig; enabled:()=>boolean }
export interface NativeMcpRun { providers:NativeMcpProvider[]; task:Task; store:Store }

const nativeName=(id:string,name:string)=>'mcp__'+id.replaceAll('-','_')+'__'+name;
const legacyName=(id:string,name:string)=>'mcp_'+id+'_'+name;
export function nativeMcpAllowed(run:NativeMcpRun):string[] {
  const child=!!run.task.parentId||!!run.task.delegation;
  const granted=new Set(run.task.delegation?.toolNames??[]);
  return run.providers.filter(p=>p.enabled()&&!!p.config.token).flatMap(({config})=>
    config.readTools.filter(name=>!child ||
      granted.has(legacyName(config.id,name))||granted.has(nativeName(config.id,name)))
      .map(name=>nativeName(config.id,name)));
}
export function nativeMcpConfig(run:NativeMcpRun):LoadedMcpConfig {
  const allowed=new Set(nativeMcpAllowed(run));
  return {
    errors:[],autoEnableCodemode:false,
    servers:run.providers.filter(p=>p.enabled()&&!!p.config.token)
      .filter(({config})=>config.readTools.some(name=>allowed.has(nativeName(config.id,name))))
      .map(({config})=>({
        name:config.id,source:'relay:trusted',scope:'extension' as const,
        config:{
          type:'http' as const,url:config.url,enabled:true,
          description:config.label+' read-only tools (Relay approved)',
          headers:{Authorization:'Bearer '+config.token},
          // Default deny: never discover arbitrary MCP writes or unknown tools.
          exposure:'hidden' as const,
          toolExposure:Object.fromEntries(config.readTools.map(name=>[name,
            allowed.has(nativeName(config.id,name))?'deferred':'hidden'])) as Record<string,'deferred'|'hidden'>
        }
      }))
  };
}

/** Call-time check: neither the Pi model nor its built-in discovery can grant tools. */
export function nativeMcpCanInvoke(run:NativeMcpRun,name:string):boolean {
  if(!nativeMcpAllowed(run).includes(name))return false;
  const scoped=!!run.task.parentId||!!run.task.delegation;
  if(!scoped)return true;
  const current=run.store.get<Task>('tasks',run.task.id);
  if(!current||current.agentRunId!==run.task.agentRunId||
      current.parentId!==run.task.parentId||
      !['running','awaiting_approval'].includes(current.state))return false;
  const parts=/^mcp__([^_]+)__(.+)$/.exec(name);
  if(!parts)return false;
  return !!current.delegation?.toolNames.some(tool=>
    tool===name || tool===legacyName(parts[1],parts[2]));
}

/** Inline policy hook. Built-in Pi MCP performs the transport, not Relay. */
export function nativeMcpAuditExtension(run:NativeMcpRun) {
  return {name:'relay-native-mcp-policy',factory:(pi:ExtensionAPI)=>{
    const active=new Map<string,{id:string;invocationId:string;providerId:string;toolName:string}>();
    pi.on('tool_call',event=>{
      if(!event.toolName.startsWith('mcp__'))return;
      const name=event.toolName;
      const match=/^mcp__([^_]+)__(.+)$/.exec(name);
      if(!match||!nativeMcpCanInvoke(run,name))return {block:true,reason:'MCP tool not permitted in Relay'};
      const key=run.task.id+':'+event.toolCallId;
      if(run.store.get('invocations',key))
        return {block:true,reason:'MCP invocation already recorded; reconcile before retry'};
      const invocationId=randomUUID();
      const args=event.input;
      const digest=createHash('sha256').update(JSON.stringify({name,args})).digest('hex');
      const record:InvocationRecord={id:key,invocationId,kind:'mcp_read',
        digest,providerId:match[1],toolName:name,state:'dispatched'};
      run.store.save('invocations',record);
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId,tool:match[1]+':'+match[2],type:'tool',state:'started'});
      active.set(event.toolCallId,{id:key,invocationId,providerId:match[1],toolName:match[2]});
    });
    pi.on('tool_result',event=>{
      const entry=active.get(event.toolCallId);
      if(!entry)return;
      active.delete(event.toolCallId);
      const stored=run.store.get<InvocationRecord>('invocations',entry.id);
      if(stored)run.store.save('invocations',{...stored,
        state:event.isError?'failed_read':'completed'});
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId:entry.invocationId,tool:entry.providerId+':'+entry.toolName,
        type:'tool',state:event.isError?'failed':'completed'});
      // No response bodies, arguments or tokens are written to event records.
    });
  }};
}
