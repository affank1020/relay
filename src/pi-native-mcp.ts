import { createHash, randomUUID } from 'node:crypto';
import type { LoadedMcpConfig } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Store, Task, InvocationRecord } from './store.js';
import type { ProviderConfig } from './integrations/manager.js';
import { observeAtlasResult } from './atlas-awareness.js';
import { observeAtlasDetailResult } from './atlas-awareness-details.js';

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
  return run.providers.filter(p=>p.enabled()&&(!!p.config.token ||
    (p.config.id==='atlas' && /^http:\/\/(?:localhost|127\.0\.0\.1|atlas)(?:[:/]|$)/.test(p.config.url)))).flatMap(({config})=>
    config.readTools.filter(name=>!child ||
      granted.has(legacyName(config.id,name))||granted.has(nativeName(config.id,name)))
      .map(name=>nativeName(config.id,name)));
}
export function nativeMcpConfig(run:NativeMcpRun):LoadedMcpConfig {
  const names=run.providers.map(p=>p.config.id.replaceAll('-','_'));
  if(new Set(names).size!==names.length)throw new Error('Colliding native MCP provider namespaces');
  const allowed=new Set(nativeMcpAllowed(run));
  return {
    errors:[],autoEnableCodemode:false,
    servers:run.providers.filter(p=>p.enabled()&&(!!p.config.token ||
    (p.config.id==='atlas' && /^http:\/\/(?:localhost|127\.0\.0\.1|atlas)(?:[:/]|$)/.test(p.config.url))))
      .filter(({config})=>config.readTools.some(name=>allowed.has(nativeName(config.id,name))))
      .map(({config})=>({
        name:config.id,source:'relay:trusted',scope:'extension' as const,
        config:{
          type:'http' as const,url:config.url,enabled:true,
          description:config.label+' read-only tools (Relay approved)',
          ...(config.token?{headers:{Authorization:'Bearer '+config.token}}:{}),
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
  const current=run.store.get<Task>('tasks',run.task.id);
  // Root sessions must also lose authority on cancellation/retry, not only
  // child sessions. Never trust a stale task object captured by Pi.
  if(!current||current.agentRunId!==run.task.agentRunId||
      current.parentId!==run.task.parentId||
      !['running','awaiting_approval'].includes(current.state))return false;
  if(!scoped)return true;
  const provider=run.providers.find(p=>p.config.readTools.some(tool=>
    nativeName(p.config.id,tool)===name));
  if(!provider)return false;
  const original=provider.config.readTools.find(tool=>nativeName(provider.config.id,tool)===name);
  return !!original && !!current.delegation?.toolNames.some(tool=>
    tool===name || tool===legacyName(provider.config.id,original));
}

/** Inline policy hook. Built-in Pi MCP performs the transport, not Relay. */
export function nativeMcpAuditExtension(run:NativeMcpRun) {
  return {name:'relay-native-mcp-policy',factory:(pi:ExtensionAPI)=>{
    const active=new Map<string,{id:string;invocationId:string;providerId:string;toolName:string}>();
    pi.on('tool_call',event=>{
      if(!event.toolName.startsWith('mcp__'))return;
      const name=event.toolName;
      const provider=run.providers.find(p=>p.config.readTools.some(tool=>nativeName(p.config.id,tool)===name));
      const method=provider?.config.readTools.find(tool=>nativeName(provider.config.id,tool)===name);
      if(!provider||!method||!nativeMcpCanInvoke(run,name))
        return {block:true,reason:'MCP tool not permitted in Relay'};
      const key=run.task.id+':'+event.toolCallId;
      if(run.store.get('invocations',key))
        return {block:true,reason:'MCP invocation already recorded; reconcile before retry'};
      const invocationId=randomUUID();
      const args=event.input;
      const digest=createHash('sha256').update(JSON.stringify({name,args})).digest('hex');
      const record:InvocationRecord={id:key,invocationId,kind:'mcp_read',
        digest,providerId:provider.config.id,toolName:name,state:'dispatched'};
      run.store.save('invocations',record);
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId,tool:provider.config.id+':'+method,type:'tool',state:'started'});
      active.set(event.toolCallId,{id:key,invocationId,providerId:provider.config.id,toolName:method});
    });
    pi.on('tool_result',event=>{
      const entry=active.get(event.toolCallId);
      if(!entry)return;
      active.delete(event.toolCallId);
      // A provider may be disabled or an agent cancelled *during* dispatch.
      // Do not deliver or audit a successful result after its authority ends.
      const revoked=!nativeMcpCanInvoke(run,event.toolName);
      const failed=event.isError||revoked;
      const stored=run.store.get<InvocationRecord>('invocations',entry.id);
      if(stored)run.store.save('invocations',{...stored,
        state:failed?'failed_read':'completed'});
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId:entry.invocationId,tool:entry.providerId+':'+entry.toolName,
        type:'tool',state:failed?'failed':'completed'});
      if(!failed&&entry.providerId==='atlas'){
        // Keep Atlas awareness as Relay's bespoke layer above Pi transport.
        // Only allowlisted, bounded resource observations enter the audit log.
        let raw:Record<string,unknown>|undefined;
        const structured=event.structuredContent;
        if(structured&&typeof structured==='object'&&!Array.isArray(structured)){
          const value=structured as Record<string,unknown>;
          raw=(value.result&&typeof value.result==='object'&&!Array.isArray(value.result)
            ?value.result:value) as Record<string,unknown>;
        }else{
          const text=event.content.filter(v=>v.type==='text').map(v=>v.text).join('');
          if(text.length<=256000)try{
            const value=JSON.parse(text) as {structuredContent?:{result?:unknown};result?:unknown};
            const candidate=value.structuredContent?.result??value.result??value;
            if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate))
              raw=candidate as Record<string,unknown>;
          }catch{/* Unsupported provider response; no synthetic observation. */}
        }
        if(raw){
          const observation=observeAtlasResult(entry.toolName,event.input,raw) ??
            observeAtlasDetailResult(entry.toolName,event.input,raw);
          if(observation)run.store.event(run.task.conversationId,{
            taskId:run.task.id,agentId:run.task.agentId??null,
            agentRunId:run.task.agentRunId??null,
            invocationId:entry.invocationId,type:'atlas_resource',state:'completed',
            atlasResource:observation});
        }
      }
      // No response bodies, arguments or tokens are written to event records.
      if(revoked)return {content:[{type:'text' as const,
        text:'MCP capability revoked while executing; no verified result available'}],
        structuredContent:null,isError:true};
    });
  }};
}
