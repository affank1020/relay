import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type } from '@sinclair/typebox';
import { supportedSchema, validRemoteArguments } from './schema.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Store, Task, ExecutionEvent } from '../store.js';
import { toolDisplayName, type ToolInvocationEnvelopeV1, type ToolInvocationState } from './contracts.js';

export interface ProviderConfig {
  id:string; label:string; url:string; token:string; readTools:readonly string[];
}
export interface IntegrationStatus {
  id:string; label:string; enabled:boolean; configured:boolean;
  state:'disabled'|'unconfigured'|'unchecked'|'ready'|'offline'; availableTools:string[];
}
const GITHUB_READ=[
  'get_me','get_file_contents','get_commit','get_latest_release','get_release_by_tag',
  'get_tag','list_branches','list_commits','list_issues','list_releases','list_tags',
  'issue_read','pull_request_read','search_code','search_issues',
  'search_pull_requests','search_repositories','get_label'
] as const;
const validId=(id:string)=>/^[a-z][a-z0-9_-]{1,23}$/.test(id);
const validTool=(id:string)=>/^[a-z][a-z0-9_]{0,63}$/.test(id);
// Operator-supplied adapters cannot promote arbitrary mutating verbs to read authority.
const genericRead=(id:string)=>/^(get|list|read|search|fetch|lookup|query)_[a-z0-9_]+$/.test(id);
export function configuredProviders(env:NodeJS.ProcessEnv):ProviderConfig[] {
  const providers:ProviderConfig[]=[{id:'github',label:'GitHub',url:'https://api.githubcopilot.com/mcp/',
    token:env.RELAY_GITHUB_TOKEN??'',readTools:GITHUB_READ}];
  const raw=env.RELAY_MCP_PROVIDERS || '[]';
  let configs:unknown;
  try {configs=JSON.parse(raw);}catch {throw new Error('Invalid RELAY_MCP_PROVIDERS');}
  if(!Array.isArray(configs)||configs.length>7)throw new Error('Invalid RELAY_MCP_PROVIDERS');
  const allowed=new Set((env.RELAY_MCP_HOST_ALLOWLIST||'').split(',').map(s=>s.trim()).filter(Boolean));
  for(const item of configs) {
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid MCP provider');
    const v=item as Record<string,unknown>;
    if(typeof v.id!=='string'||!validId(v.id)||v.id==='github'||providers.some(p=>p.id===v.id)||
       typeof v.label!=='string'||v.label.length<1||v.label.length>48||
       typeof v.url!=='string'||typeof v.tokenEnv!=='string'||
       !/^RELAY_MCP_TOKEN_[A-Z0-9_]{1,40}$/.test(v.tokenEnv)||
       !Array.isArray(v.readTools)||v.readTools.length>30||
       v.readTools.some(t=>typeof t!=='string'||!validTool(t)||!genericRead(t)))
      throw new Error('Invalid MCP provider');
    let url:URL;
    try {url=new URL(v.url);}catch {throw new Error('Invalid MCP provider URL');}
    if(url.protocol!=='https:'||!!url.username||!!url.password||!!url.hash||!!url.search||
       !!url.port||!allowed.has(url.hostname)||!url.pathname.startsWith('/'))
      throw new Error('MCP provider host must be explicitly allowlisted');
    providers.push({id:v.id,label:v.label,url:url.toString(),
      token:env[v.tokenEnv]??'',readTools:[...new Set(v.readTools as string[])]});
  }
  return providers;
}
interface ListedTool {name:string;description?:string;inputSchema:Record<string,unknown>}
export interface ProviderTransport {
  list(signal:AbortSignal):Promise<ListedTool[]>;
  call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;
  close():Promise<void>;
}
export class HttpProviderTransport implements ProviderTransport {
  private client?:Promise<Client>;
  constructor(private readonly config:ProviderConfig) {}
  private connect():Promise<Client> {
    return this.client ??= (async()=>{
      const client=new Client({name:'relay-'+this.config.id,version:'1.0.0'});
      const transport=new StreamableHTTPClientTransport(new URL(this.config.url),
        {requestInit:{headers:{Authorization:'Bearer '+this.config.token},redirect:'error'}});
      try {await client.connect(transport,{timeout:8000});return client;}
      catch(error){this.client=undefined;await client.close().catch(()=>{});throw error;}
    })();
  }
  async list(signal:AbortSignal):Promise<ListedTool[]> {
    const client=await this.connect(),tools:ListedTool[]=[];
    let cursor:string|undefined;
    for(let page=0;page<3;page++){
      signal.throwIfAborted();
      const response=await client.listTools(cursor?{cursor}:undefined,{signal,timeout:8000});
      tools.push(...response.tools);
      if(tools.length>64)throw new Error('Tool catalogue limit exceeded');
      cursor=response.nextCursor;
      if(!cursor)return tools;
    }
    throw new Error('Tool catalogue page limit exceeded');
  }
  async call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
    const client=await this.connect();
    return client.callTool({name,arguments:args},undefined,{signal,timeout:20000});
  }
  async close():Promise<void>{if(this.client)await (await this.client).close().catch(()=>{});this.client=undefined;}
}
const safeSchema=(schema:Record<string,unknown>):boolean=>{
  try {
    const serialized=JSON.stringify(schema);
    return serialized.length<=16_384&&schema.type==='object'&&supportedSchema(schema);
  }catch{return false;}
};
export class ConnectionManager {
  private readonly transports=new Map<string,ProviderTransport>();
  private readonly states=new Map<string,'ready'|'offline'>();
  private readonly inventory=new Map<string,string[]>();
  constructor(private readonly configs:ProviderConfig[],private readonly enabled:(id:string)=>boolean,
    private readonly makeTransport:(config:ProviderConfig)=>ProviderTransport=c=>new HttpProviderTransport(c)) {}
  contains(id:string):boolean{return this.configs.some(p=>p.id===id);}
  list():IntegrationStatus[]{
    return this.configs.map(p=>({
      id:p.id,label:p.label,enabled:this.enabled(p.id),configured:!!p.token,
      state:!this.enabled(p.id)?'disabled':!p.token?'unconfigured':this.states.get(p.id)??'unchecked',
      availableTools:this.inventory.get(p.id)??[]
    }));
  }
  private transport(config:ProviderConfig):ProviderTransport {
    let existing=this.transports.get(config.id);
    if(!existing){existing=this.makeTransport(config);this.transports.set(config.id,existing);}
    return existing;
  }
  async tools(task:Task,store:Store,signal:AbortSignal):Promise<ToolDefinition[]> {
    const result:ToolDefinition[]=[];
    for(const config of this.configs){
      if(!this.enabled(config.id)||!config.token)continue;
      try{
        const available=await this.transport(config).list(signal);
        signal.throwIfAborted();
        this.states.set(config.id,'ready');
        const admitted=available.filter(t=>config.readTools.includes(t.name) && validTool(t.name) && safeSchema(t.inputSchema))
          .slice(0,32);
        this.inventory.set(config.id,admitted.map(t=>t.name));
        for(const tool of admitted){
          const name='mcp_'+config.id+'_'+tool.name;
          result.push({
            name,label:config.label+' · '+tool.name,description:(tool.description??tool.name).slice(0,2000),
            parameters:Type.Unsafe<Record<string,unknown>>(tool.inputSchema),
            execute:async (callId,argumentsValue)=>{
              const data=argumentsValue as Record<string,unknown>;
              const output=await this.invoke(config,tool,task,store,callId,data,signal);
              return {content:[{type:'text' as const,text:JSON.stringify(output)}],details:{}};
            }
          });
        }
      }catch{
        signal.throwIfAborted();
        this.states.set(config.id,'offline');this.inventory.delete(config.id);
      }
    }
    return result;
  }
  async invoke(config:ProviderConfig,tool:ListedTool,task:Task,store:Store,callId:string,
    args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    const invocationId=randomUUID(),label=toolDisplayName(config.id,tool.name);
    const fields:Partial<ExecutionEvent>={taskId:task.id,agentRunId:task.id,invocationId,
      tool:label,type:'tool'};
    const emit=(state:ToolInvocationState)=>{
      const envelope:ToolInvocationEnvelopeV1={schemaVersion:1,providerId:config.id,
        toolName:tool.name,taskId:task.id,agentRunId:task.id,invocationId,
        state,timestamp:new Date().toISOString()};
      // Preserve schema-v1 event compatibility until orchestration owns run schema.
      store.event(task.conversationId,{...fields,state,...{providerId:envelope.providerId}});
    };
    // Check CURRENT server policy at invocation, not only at model discovery.
    if(!this.enabled(config.id)||!config.readTools.includes(tool.name)||!config.token) {
      emit('denied');throw new Error('MCP tool is not permitted');
    }
    const key=task.id+':'+callId;
    const digest=createHash('sha256').update(JSON.stringify({provider:config.id,tool:tool.name,args})).digest('hex');
    if(store.get('invocations',key)){emit('denied');throw new Error('MCP invocation already recorded');}
    if(!args||typeof args!=='object'||Array.isArray(args)||!safeSchema(tool.inputSchema)||
       !validRemoteArguments(tool.inputSchema,args)) {
      emit('denied');throw new Error('MCP arguments failed schema validation');
    }
    store.save('invocations',{id:key,digest,state:'validating'} as {id:string});
    emit('validating');
    try{
      signal.throwIfAborted();
      store.save('invocations',{id:key,digest,state:'dispatched'} as {id:string});
      emit('started');
      const result=await this.transport(config).call(tool.name,args,signal);
      if(JSON.stringify(result).length>100_000)throw new Error('MCP response exceeds limit');
      if(result && typeof result==='object' && 'isError' in result && result.isError)
        throw new Error('MCP provider reported an error');
      store.save('invocations',{id:key,digest,state:'completed'} as {id:string});
      emit('completed');
      return result;
    }catch{
      store.save('invocations',{id:key,digest,state:'uncertain'} as {id:string});
      emit(signal.aborted?'cancelled':'failed');
      throw new Error('MCP call failed; verify provider state before retrying');
    }
  }
  async close():Promise<void>{await Promise.all([...this.transports.values()].map(t=>t.close()));}
}
