import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Store, type Task, type ExecutionEvent } from './store.js';
import { observeAtlasResult, type AtlasCheckoutFact } from './atlas-awareness.js';
import { observeAtlasDetailResult } from './atlas-awareness-details.js';

export const READ_TOOLS = new Set(['get_atlas_status','list_projects','get_project','list_nodes','get_node','list_workspaces','get_workspace','list_logical_workspaces','list_project_workspaces','list_applications','get_application','list_stores','get_store','list_records','get_record','list_views','get_view','workspace_list_files','workspace_read_file','workspace_search_files','workspace_git_status','workspace_git_diff','workspace_git_list_worktrees','workspace_list_dev_tasks',
  'code_reviews_overview','code_reviews_pr_summary','code_reviews_list_findings']);
export interface AtlasTransport { list(): Promise<Array<{name:string;description?:string;inputSchema:Record<string,unknown>}>>; call(name:string,args:Record<string,unknown>,signal?:AbortSignal): Promise<unknown>; close(): Promise<void>; }
export class McpTransport implements AtlasTransport {
  private connection?: Promise<Client>;
  constructor(private url:string, private token:string) {
    const u=new URL(url);
    if(u.username || u.password || u.search || u.hash || (u.protocol!=='https:' && !(u.protocol==='http:' && ['127.0.0.1','localhost','atlas'].includes(u.hostname)))) throw new Error('Atlas requires HTTPS or a trusted local endpoint');
  }
  private connect() {
    return this.connection ??= (async()=>{
      const client=new Client({name:'relay',version:'1.0.0'});
      const transport=new StreamableHTTPClientTransport(new URL(this.url),{requestInit:{headers:this.token?{Authorization:'Bearer '+this.token}:{},redirect:'error'}});
      try { await client.connect(transport,{timeout:15000}); return client; }
      catch(e) { await client.close().catch(()=>{}); this.connection=undefined; throw e; }
    })();
  }
  async list() {
    const client=await this.connect(); const tools: Array<{name:string;description?:string;inputSchema:Record<string,unknown>}>=[];
    let cursor:string|undefined;
    for(let page=0;page<20;page++) { const r=await client.listTools(cursor?{cursor}:undefined,{timeout:15000}); tools.push(...r.tools); cursor=r.nextCursor; if(!cursor)return tools; }
    throw new Error('Atlas tool catalogue exceeded page limit');
  }
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal) {
    const client=await this.connect();
    // Never automatically replay a failed or ambiguous dispatch.
    return client.callTool({name,arguments:args},undefined,{timeout:120000,signal});
  }
  async close() { if(this.connection) await (await this.connection).close(); }
}
export function payload(value: unknown): Record<string,unknown> {
  if(!value || typeof value!=='object')return {};
  const v=value as Record<string,unknown>;
  const s=v.structuredContent as {result?:unknown}|undefined;
  if(s?.result && typeof s.result==='object' && !Array.isArray(s.result))return s.result as Record<string,unknown>;
  return {};
}
const uuid=(v:unknown):string|null => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)?v:null;
export class Gateway {
  constructor(private store:Store, private transport:AtlasTransport, private devTasks:Record<string,string[]>,
    private approve:(task:Task,id:string,tool:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<void>) {}
  async tools(task:Task,signal:AbortSignal):Promise<ToolDefinition[]> {
    const available=await this.transport.list();
    return available.filter(t=>READ_TOOLS.has(t.name) || (t.name==='workspace_run_dev_task' && Object.keys(this.devTasks).length>0)).map(t=>({
      name:'atlas_'+t.name,label:'Atlas · '+t.name,description:t.description || t.name,
      parameters:Type.Unsafe<Record<string,unknown>>(t.inputSchema),
      execute:async (id,args) => {
        const result=await this.invoke(task,id,t.name,args as Record<string,unknown>,signal);
        return {content:[{type:'text' as const,text:JSON.stringify(result)}],details:result};
      }
    }));
  }
  async invoke(task:Task,callId:string,name:string,args:Record<string,unknown>,signal:AbortSignal,
    internalRead=false):Promise<unknown> {
    // The internal flag is only for the two server-side placement verification
    // reads. They remain on READ_TOOLS and never enter the child's Pi tool list.
    if(internalRead && name!=='get_workspace' && name!=='get_node')
      throw new Error('Invalid internal verification tool');
    if((task.parentId || task.delegation) && (!READ_TOOLS.has(name) ||
      (!internalRead && !task.delegation?.toolNames.includes('atlas_'+name))))
      throw new Error('Child agent capability denied');
    const key=task.id+':'+callId;
    const digest=createHash('sha256').update(JSON.stringify({name,args})).digest('hex');
    const previous=this.store.get<{id:string;digest:string;state:string;result?:unknown}>('invocations',key);
    if(previous) {
      if(previous.digest!==digest)throw new Error('Invocation identity conflict');
      if(previous.state==='completed')return previous.result;
      throw new Error('Invocation already dispatched; reconciliation required');
    }
    const id=randomUUID();
    const fields:Partial<ExecutionEvent>={taskId:task.id,agentId:task.agentId??null,agentRunId:task.agentRunId??null,
      parentTaskId:task.parentId??null,invocationId:id,tool:name,type:'tool',
      projectId:uuid(args.projectId),workspaceId:uuid(args.checkoutId ?? args.workspaceId)};
    const emit=(state:string,extra:Partial<ExecutionEvent>={})=>this.store.event(task.conversationId,{...fields,...extra,state});
    if(!READ_TOOLS.has(name) && name!=='workspace_run_dev_task') { emit('denied'); throw new Error('Tool is not permitted'); }
    if(name==='workspace_run_dev_task' && (!fields.workspaceId || !this.devTasks[fields.workspaceId]?.includes(String(args.task)))) {
      emit('denied'); throw new Error('Development task is not configured in Relay allowlist');
    }
    this.store.save('invocations',{id:key,digest,state:'validating'} as {id:string});
    emit('validating');
    try {
      signal.throwIfAborted();
      let resolvedCheckout:AtlasCheckoutFact|undefined;
      if(name.startsWith('workspace_')) {
        if(!fields.workspaceId)throw new Error('A checkout ID is required');
        const workspace=payload(await this.invoke(task,callId+':workspace','get_workspace',{checkoutId:fields.workspaceId},signal,true));
        const nodeId=uuid(workspace.nodeId);
        if(!nodeId || workspace.status!=='active')throw new Error('Active checkout placement unavailable');
        // Placement is a resolved relationship, not proof that the Node ran the tool.
        if(workspace.id && workspace.id!==fields.workspaceId)throw new Error('Checkout identity changed');
        resolvedCheckout={id:fields.workspaceId,nodeId};
        fields.selectedNodeId=nodeId;
        const node=payload(await this.invoke(task,callId+':node','get_node',{nodeId},signal,true));
        const capability=name.startsWith('workspace_git_')?'workspace.git':name.includes('dev_task')?'workspace.dev':'workspace.files';
        // Atlas get_node contracts may nest the Node. Never infer capability from OS.
        const details=(node.node && typeof node.node==='object'?node.node:node) as Record<string,unknown>;
        if(details.status!=='online' || !Array.isArray(details.capabilities) || !details.capabilities.includes(capability))throw new Error('Node does not advertise required capability');
        if(name==='workspace_run_dev_task') {
          await this.approve(task,id,name,{...args,selectedNodeId:nodeId},signal);
          const placement=payload(await this.invoke(task,callId+':placement-check','get_workspace',{checkoutId:fields.workspaceId},signal,true));
          const fresh=payload(await this.invoke(task,callId+':capability-check','get_node',{nodeId},signal,true));
          if(placement.nodeId!==nodeId || placement.status!=='active' || fresh.status!=='online' || !Array.isArray(fresh.capabilities) || !fresh.capabilities.includes(capability))throw new Error('Placement or capability changed during approval');
        }
      }
      signal.throwIfAborted();
      this.store.save('invocations',{id:key,digest,state:'dispatched'} as {id:string});
      emit('started');
      const result=await this.transport.call(name,args,signal);
      if(JSON.stringify(result).length>2_000_000)throw new Error('Atlas result exceeds safety bound');
      const raw=payload(result);
      const failed=!!(result && typeof result==='object' && 'isError' in result && result.isError) || raw.success===false;
      // Only an execution receipt with matching checkout and task establishes actual execution.
      const actual=name==='workspace_run_dev_task' && raw.workspaceId===fields.workspaceId && raw.task===args.task ? uuid(raw.nodeId):null;
      const observation=failed?null:(observeAtlasResult(name,args,raw,resolvedCheckout)??
        observeAtlasDetailResult(name,args,raw));
      // A completed invocation and its safe observation are one durable receipt.
      // Replaying an existing call ID returns the saved result without re-emitting.
      this.store.transaction(()=>{
        this.store.save('invocations',{id:key,digest,state:'completed',result} as {id:string});
        emit(failed?'failed':'completed',{executingNodeId:actual,atlasOperationId:uuid(raw.operationId)});
        if(observation)this.store.event(task.conversationId,{...fields,type:'atlas_resource',
          state:'completed',atlasResource:observation});
      });
      return result;
    } catch(error) {
      this.store.save('invocations',{id:key,digest,state:'uncertain'} as {id:string});
      emit(signal.aborted?'cancelled':'failed');
      throw new Error(signal.aborted?'Atlas invocation cancelled; reconcile any dispatched operation':'Atlas invocation failed; inspect Atlas before retrying');
    }
  }
}
