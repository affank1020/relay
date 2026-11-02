import { createHash, randomUUID } from 'node:crypto';
import type { LoadedMcpConfig } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Store, Task, InvocationRecord } from './store.js';
import type { ProviderConfig } from './integrations/manager.js';
import { GITHUB_WRITES, approvedGitHubWriteArgs, isGitHubWrite } from './integrations/github-writes.js';
import type { WriteApproval } from './integrations/manager.js';
import { observeAtlasResult, type AtlasCheckoutFact } from './atlas-awareness.js';
import { observeAtlasDetailResult } from './atlas-awareness-details.js';
import { ATLAS_CODING_TOOLS, isAtlasCodingTool, codingCheckoutInput,
  codingCheckoutPermitted, sensitiveCodingTool, validCheckoutId,
  type CodingCheckout } from './atlas-coding.js';

// Pi's own MCP transport/discovery owns connections and tool definitions.
// Relay owns just admission and durable event attribution. Never load ambient
// mcp.json, project resources or arbitrary tools in this server process.
export interface NativeMcpProvider { config:ProviderConfig; enabled:()=>boolean }
export interface NativeMcpRun { providers:NativeMcpProvider[]; task:Task; store:Store; approve?:WriteApproval; signal?:AbortSignal;
  devTasks?:Record<string,string[]>;
  /** Independent server-side reads, never delegated to the model. */
  atlasCodingInspect?:(checkoutId:string,signal:AbortSignal)=>Promise<CodingCheckout>;
}

const nativeName=(id:string,name:string)=>'mcp__'+id.replaceAll('-','_')+'__'+name;
const providerTools=(run:NativeMcpRun,config:ProviderConfig)=>[
  ...config.readTools,
  ...(!run.task.parentId&&!run.task.delegation&&config.id==='github'&&config.writeRepositories?.length&&run.approve?GITHUB_WRITES:[]),
  ...(!run.task.parentId&&!run.task.delegation&&config.id==='atlas'&&config.codingCheckouts?.length&&
      run.approve&&run.signal&&run.atlasCodingInspect?ATLAS_CODING_TOOLS:[])
];
export function nativeMcpAllowed(run:NativeMcpRun):string[] {
  const child=!!run.task.parentId||!!run.task.delegation;
  const granted=new Set(run.task.delegation?.toolNames??[]);
  return run.providers.filter(p=>p.enabled()&&(!!p.config.token ||
    (p.config.id==='atlas' && /^http:\/\/(?:localhost|127\.0\.0\.1|atlas)(?:[:/]|$)/.test(p.config.url)))).flatMap(({config})=>
    providerTools(run,config).filter(name=>!child || granted.has(nativeName(config.id,name)))
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
      .filter(({config})=>providerTools(run,config).some(name=>allowed.has(nativeName(config.id,name))))
      .map(({config})=>({
        name:config.id,source:'relay:trusted',scope:'extension' as const,
        config:{
          type:'http' as const,url:config.url,enabled:true,
          description:config.label+' tools (Relay approved)',
          ...(config.token?{headers:{Authorization:'Bearer '+config.token}}:{}),
          // Default deny: never discover arbitrary MCP writes or unknown tools.
          exposure:'hidden' as const,
          toolExposure:Object.fromEntries(providerTools(run,config).map(name=>[name,
            allowed.has(nativeName(config.id,name))?'deferred':'hidden'])) as Record<string,'deferred'|'hidden'>
        }
      }))
  };
}

/** Call-time check: neither the Pi model nor its built-in discovery can grant tools. */
export function nativeMcpCanInvoke(run:NativeMcpRun,name:string):boolean {
  if(run.signal?.aborted||!nativeMcpAllowed(run).includes(name))return false;
  const scoped=!!run.task.parentId||!!run.task.delegation;
  const current=run.store.get<Task>('tasks',run.task.id);
  // Root sessions must also lose authority on cancellation/retry, not only
  // child sessions. Never trust a stale task object captured by Pi.
  if(!current||current.agentRunId!==run.task.agentRunId||
      current.parentId!==run.task.parentId||
      !['running','awaiting_approval'].includes(current.state))return false;
  if(!scoped)return true;
  const provider=run.providers.find(p=>providerTools(run,p.config).some(tool=>
    nativeName(p.config.id,tool)===name));
  if(!provider)return false;
  const original=provider.config.readTools.find(tool=>nativeName(provider!.config.id,tool)===name);
  return !!original && !!current.delegation?.toolNames.some(tool=>
    tool===name);
}

/** Inline policy hook. Built-in Pi MCP performs the transport, not Relay. */
export function nativeMcpAuditExtension(run:NativeMcpRun) {
  return {name:'relay-native-mcp-policy',factory:(pi:ExtensionAPI)=>{
    const checkouts=new Map<string,AtlasCheckoutFact>();
    const newCodingCheckouts=new Set<string>();
    const approvedCodingScopes=new Set<string>();
    const active=new Map<string,{id:string;invocationId:string;providerId:string;toolName:string;
      codingCheckoutId?:string;codingNodeId?:string;codingRepository?:string;codingBranch?:string}>();
    pi.on('tool_call',async event=>{
      if(!event.toolName.startsWith('mcp__'))return;
      const name=event.toolName;
      const provider=run.providers.find(p=>providerTools(run,p.config).some(tool=>nativeName(p.config.id,tool)===name));
      const method=(provider?providerTools(run,provider.config):[]).find(tool=>nativeName(provider!.config.id,tool)===name);
      if(!provider||!method||!nativeMcpCanInvoke(run,name))
        return {block:true,reason:'MCP tool not permitted in Relay'};
      const key=run.task.id+':'+event.toolCallId;
      if(run.store.get('invocations',key))
        return {block:true,reason:'MCP invocation already recorded; reconcile before retry'};
      const invocationId=randomUUID();
      const args=event.input;
      const digest=createHash('sha256').update(JSON.stringify({name,args})).digest('hex');
      const githubWrite=provider.config.id==='github'&&isGitHubWrite(method);
      const atlasWrite=provider.config.id==='atlas'&&isAtlasCodingTool(method);
      const writing=githubWrite||atlasWrite;
      const record:InvocationRecord={id:key,invocationId,taskId:run.task.id,kind:writing?'mcp_write':'mcp_read',
        digest,providerId:provider.config.id,toolName:name,state:'dispatched'};
      let codingCheckout:CodingCheckout|undefined;
      let codingCheckoutId:string|undefined;
      if(writing){
        if(!run.approve||!run.signal)return {block:true,reason:'Write approval unavailable'};
        if(atlasWrite){
          codingCheckoutId=codingCheckoutInput(args)??undefined;
          const rootAllowed=!!codingCheckoutId && !!provider.config.codingCheckouts?.includes(codingCheckoutId);
          if(!codingCheckoutId||(!rootAllowed&&!newCodingCheckouts.has(codingCheckoutId)))
            return {block:true,reason:'Checkout not approved for Relay coding'};
          // A configured base checkout is only allowed to spawn an isolated worktree.
          if(method==='workspace_git_create_worktree'){
            if(!rootAllowed||typeof (args as Record<string,unknown>).branch!=='string'||
              !/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/.test(String((args as Record<string,unknown>).branch)))
              return {block:true,reason:'Only approved bases may create atlas/* worktrees'};
          }
          if(method==='workspace_run_dev_task'&&
            !run.devTasks?.[codingCheckoutId]?.includes(String((args as Record<string,unknown>).task)))
            return {block:true,reason:'Development task not in the operator allowlist'};
          try {
            codingCheckout=await run.atlasCodingInspect?.(codingCheckoutId,run.signal);
          }catch {
            return {block:true,reason:'Could not verify live Atlas checkout and Node'};
          }
          if(!codingCheckout||codingCheckout.id!==codingCheckoutId||
             !codingCheckoutPermitted(codingCheckout,method))
            return {block:true,reason:'Checkout branch, Node or capability not approved'};
          const callArgs=args as Record<string,unknown>;
          if(method==='workspace_git_open_pull_request'&&
            (callArgs.repository!==codingCheckout.repository||callArgs.branch!==codingCheckout.branch))
            return {block:true,reason:'Pull request repository or branch differs from verified checkout'};
          if(method==='workspace_git_push_branch'&&
            (callArgs.repository!==undefined&&callArgs.repository!==codingCheckout.repository||
             callArgs.branch!==undefined&&callArgs.branch!==codingCheckout.branch))
            return {block:true,reason:'Push differs from verified checkout'};
        }
        const safe=githubWrite?approvedGitHubWriteArgs(method,args,provider.config.writeRepositories??[]):args;
        if(!safe||typeof safe!=='object'||Array.isArray(safe))
          return {block:true,reason:'Write scope not permitted'};
        run.store.save('invocations',{...record,state:'validating'});
        try {
          if(atlasWrite&&codingCheckoutId){
            // One approval authorises bounded file edits/commits on this worktree
            // for this one parent turn. External publication stays per-call.
            if(method==='workspace_git_create_worktree'||sensitiveCodingTool(method)){
              await run.approve(run.task,invocationId,'atlas:'+method,safe as Record<string,unknown>,run.signal);
            }else if(!approvedCodingScopes.has(codingCheckoutId)){
              await run.approve(run.task,invocationId,'atlas:coding_checkout',
                {checkoutId:codingCheckoutId,branch:codingCheckout!.branch,
                  repository:codingCheckout!.repository,nodeId:codingCheckout!.nodeId,
                  scope:'bounded file edits, Git staging/commits and configured development tasks during this turn'},run.signal);
              approvedCodingScopes.add(codingCheckoutId);
            }
          }else{
            await run.approve(run.task,invocationId,provider.config.id+':'+method,safe as Record<string,unknown>,run.signal);
          }
          run.signal.throwIfAborted();
          if(!nativeMcpCanInvoke(run,name))throw new Error('Revoked');
          // Placement can change while the user is reviewing a permission.
          if(atlasWrite&&codingCheckoutId){
            const latest=await run.atlasCodingInspect?.(codingCheckoutId,run.signal);
            if(!latest||latest.id!==codingCheckoutId||latest.nodeId!==codingCheckout!.nodeId||
               latest.repository!==codingCheckout!.repository||
               !codingCheckoutPermitted(latest,method))
              throw new Error('Checkout changed during approval');
          }
        }catch{
          run.store.save('invocations',{...record,state:'denied_before_dispatch'});
          return {block:true,reason:'Coding authority denied, changed or revoked'};
        }
      }
      run.store.save('invocations',record);
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId,tool:provider.config.id+':'+method,type:'tool',state:'started'});
      active.set(event.toolCallId,{id:key,invocationId,providerId:provider.config.id,toolName:method,
        codingCheckoutId,codingNodeId:codingCheckout?.nodeId,
        codingRepository:codingCheckout?.repository,
        codingBranch:typeof (args as Record<string,unknown>).branch==='string'?
          String((args as Record<string,unknown>).branch):undefined});
    });
    pi.on('tool_result',async event=>{
      const entry=active.get(event.toolCallId);
      if(!entry)return;
      active.delete(event.toolCallId);
      // A provider may be disabled or an agent cancelled *during* dispatch.
      // Do not deliver or audit a successful result after its authority ends.
      const revoked=!nativeMcpCanInvoke(run,event.toolName);
      let failed=event.isError||revoked;
      // Admit a freshly-created worktree only after independent verification.
      // Never trust a model-selected ID or permit writes to the original main checkout.
      if(!failed&&entry.providerId==='atlas'&&entry.toolName==='workspace_git_create_worktree'&&
         run.atlasCodingInspect&&run.signal){
        try{
          const envelope=event.structuredContent as {structuredContent?:unknown}|undefined;
          let response=envelope?.structuredContent;
          if(!response){
            const text=event.content.filter(v=>v.type==='text').map(v=>v.text).join('');
            if(text.length<=256000)response=JSON.parse(text);
          }
          const value=response as {result?:Record<string,unknown>}|undefined;
          const raw=value?.result??response as Record<string,unknown>|undefined;
          const created=(raw?.checkout && typeof raw.checkout==='object'?
            raw.checkout:raw?.workspace && typeof raw.workspace==='object'?
            raw.workspace:raw) as Record<string,unknown>|undefined;
          const id=created?.checkoutId??created?.id;
          if(validCheckoutId(id)){
            const inspected=await run.atlasCodingInspect(id.toLowerCase(),run.signal);
            if(inspected.id===id.toLowerCase()&&inspected.nodeId===entry.codingNodeId&&
               inspected.repository===entry.codingRepository&&
               inspected.branch===entry.codingBranch&&
               codingCheckoutPermitted(inspected,'workspace_patch_file'))
              newCodingCheckouts.add(id.toLowerCase());
          }
        }catch{/* The worktree may exist, but no unverified coding grant is issued. */}
      }
      const stored=run.store.get<InvocationRecord>('invocations',entry.id);
      if(stored)run.store.save('invocations',{...stored,
        state:failed?(stored.kind==='mcp_write'?'uncertain':'failed_read'):'completed'});
      run.store.event(run.task.conversationId,{taskId:run.task.id,
        agentId:run.task.agentId??null,agentRunId:run.task.agentRunId??null,
        invocationId:entry.invocationId,tool:entry.providerId+':'+entry.toolName,
        type:'tool',state:failed?'failed':'completed'});
      if(!failed&&entry.providerId==='atlas'){
        // Keep Atlas awareness as Relay's bespoke layer above Pi transport.
        // Only allowlisted, bounded resource observations enter the audit log.
        let raw:Record<string,unknown>|undefined;
        // Pi 1.4 exposes the original MCP CallToolResult as structuredContent.
        // The service's structuredContent is one level inside that envelope.
        const envelope=event.structuredContent as {structuredContent?:unknown}|undefined;
        let payload=envelope?.structuredContent;
        if(payload===undefined){
          const text=event.content.filter(v=>v.type==='text').map(v=>v.text).join('');
          if(text.length<=256000)try{payload=JSON.parse(text);}catch{/* Non-JSON result. */}
        }
        if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
          const value=payload as Record<string,unknown>;
          const candidate=value.result??value;
          if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate))raw=candidate as Record<string,unknown>;
        }
        if(raw){
          const checkoutId=String(event.input.checkoutId??event.input.workspaceId??'').toLowerCase();
          const observation=observeAtlasResult(entry.toolName,event.input,raw,checkouts.get(checkoutId)) ??
            observeAtlasDetailResult(entry.toolName,event.input,raw);
          if(observation?.checkout){
            checkouts.set(observation.checkout.id,observation.checkout);
            if(checkouts.size>128)checkouts.delete(checkouts.keys().next().value!);
          }
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
