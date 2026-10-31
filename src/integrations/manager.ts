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
type McpClientConnection=Pick<Client,'listTools'|'callTool'|'close'>;
interface McpSession {
  promise:Promise<McpClientConnection>;
  active:number;
  stale:boolean;
  closed:boolean;
}
export class HttpProviderTransport implements ProviderTransport {
  private session?:McpSession;
  // Injection tests a genuine session lifecycle without using live credentials.
  constructor(private readonly config:ProviderConfig,
    private readonly open?:()=>Promise<McpClientConnection>) {}
  private getSession():McpSession {
    if(this.session)return this.session;
    const session:McpSession={
      promise:this.open?this.open():this.openHttp(),
      active:0,stale:false,closed:false
    };
    this.session=session;
    // Initial handshake failures cannot poison future attempts.
    void session.promise.catch(()=>{
      if(this.session===session)this.session=undefined;
    });
    return session;
  }
  private async retireIdle(session:McpSession):Promise<void> {
    if(!session.stale||session.active||session.closed)return;
    session.closed=true;
    // Close only when every request using this particular client has settled.
    await session.promise.then(client=>client.close()).catch(()=>{});
  }
  private async withClient<T>(operation:(client:McpClientConnection)=>Promise<T>):Promise<T> {
    const session=this.getSession();
    // Reserve before awaiting connect, so a simultaneous failure cannot close
    // a connection before another caller has even entered its RPC.
    session.active++;
    try{
      return await operation(await session.promise);
    }catch(error){
      session.stale=true;
      if(this.session===session)this.session=undefined;
      // Retire this generation for new calls but DO NOT interrupt active peers.
      // An ambiguous invocation is never automatically retried.
      throw error;
    }finally{
      session.active--;
      await this.retireIdle(session);
    }
  }
  private async openHttp():Promise<McpClientConnection> {
    const client=new Client({name:'relay-'+this.config.id,version:'1.0.0'});
    const transport=new StreamableHTTPClientTransport(new URL(this.config.url),
      {requestInit:{headers:{Authorization:'Bearer '+this.config.token},redirect:'error'}});
    try {await client.connect(transport,{timeout:8000});return client;}
    catch(error){await client.close().catch(()=>{});throw error;}
  }
  async list(signal:AbortSignal):Promise<ListedTool[]> {
    return this.withClient(async client=>{
      const tools:ListedTool[]=[];
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
    });
  }
  async call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
    return this.withClient(client=>client.callTool({name,arguments:args},undefined,{signal,timeout:20000}));
  }
  async close():Promise<void>{
    const session=this.session;
    this.session=undefined;
    if(session){session.stale=true;await this.retireIdle(session);}
  }
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
    const delegated=!!task.parentId||!!task.delegation;
    const admittedNames=task.delegation?.toolNames??[];
    // No delegated MCP permission means no remote discovery. A child with
    // only Atlas access should not contact unrelated configured providers.
    if(delegated&&!admittedNames.some(name=>name.startsWith('mcp_')))return result;
    for(const config of this.configs){
      if(!this.enabled(config.id)||!config.token||
         (delegated&&!admittedNames.some(name=>name.startsWith('mcp_'+config.id+'_'))))continue;
      try{
        const available=await this.transport(config).list(signal);
        signal.throwIfAborted();
        this.states.set(config.id,'ready');
        const admitted=available.filter(t=>config.readTools.includes(t.name) && validTool(t.name) && safeSchema(t.inputSchema))
          .slice(0,32);
        this.inventory.set(config.id,admitted.map(t=>t.name));
        for(const tool of admitted){
          const name='mcp_'+config.id+'_'+tool.name;
          // Delegated agents may discover ONLY their explicit parent-admitted
          // read tools. Root registry policy is never inherited wholesale.
          if((task.parentId||task.delegation)&&!task.delegation?.toolNames.includes(name))continue;
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
    const fields:Partial<ExecutionEvent>={taskId:task.id,agentRunId:task.agentRunId??task.id,invocationId,
      tool:label,type:'tool'};
    const emit=(state:ToolInvocationState)=>{
      const envelope:ToolInvocationEnvelopeV1={schemaVersion:1,providerId:config.id,
        toolName:tool.name,taskId:task.id,agentRunId:task.agentRunId??task.id,invocationId,
        state,timestamp:new Date().toISOString()};
      // Preserve schema-v1 event compatibility until orchestration owns run schema.
      store.event(task.conversationId,{...fields,state,...{providerId:envelope.providerId}});
    };
    // Check current server and per-agent delegated policy again at invocation.
    // Revocation, a mutated task record, or a changed execution identity
    // cannot turn a stale previously discovered tool into an allowed call.
    const scoped=!!task.parentId||!!task.delegation;
    const current=scoped?store.get<Task>('tasks',task.id):undefined;
    const allowedName='mcp_'+config.id+'_'+tool.name;
    if(!this.enabled(config.id)||!config.readTools.includes(tool.name)||!config.token ||
      (scoped && (!task.delegation?.toolNames.includes(allowedName) ||
        !current?.delegation?.toolNames.includes(allowedName) ||
        current.agentRunId!==task.agentRunId || current.parentId!==task.parentId ||
        !['running','awaiting_approval'].includes(current.state)))) {
      emit('denied');throw new Error('MCP tool is not permitted');
    }
    const key=task.id+':'+callId;
    const digest=createHash('sha256').update(JSON.stringify({provider:config.id,tool:tool.name,args})).digest('hex');
    if(store.get('invocations',key)){emit('denied');throw new Error('MCP invocation already recorded');}
    if(!args||typeof args!=='object'||Array.isArray(args)||!safeSchema(tool.inputSchema)||
       !validRemoteArguments(tool.inputSchema,args)) {
      emit('denied');throw new Error('MCP arguments failed schema validation');
    }
    // Record this as a server-admitted read-only request, distinct from Atlas
    // development tasks. Only these records may be explicitly reconciled.
    const record={id:key,digest,kind:'mcp_read' as const,providerId:config.id,
      toolName:label,invocationId};
    store.save('invocations',{...record,state:'validating'});
    emit('validating');
    let dispatched=false,receivedResponse=false;
    try{
      signal.throwIfAborted();
      store.save('invocations',{...record,state:'dispatched'});
      dispatched=true;
      emit('started');
      const result=await this.transport(config).call(tool.name,args,signal);
      receivedResponse=true;
      if(JSON.stringify(result).length>100_000)throw new Error('MCP response exceeds limit');
      if(result && typeof result==='object' && 'isError' in result && result.isError)
        throw new Error('MCP provider reported an error');
      store.save('invocations',{...record,state:'completed'});
      emit('completed');
      return result;
    }catch{
      // An explicit provider error, oversized response or aborted preflight
      // is a known terminal read failure, not an unknown write side effect.
      // Only errors after an attempted dispatch with no response are uncertain.
      store.save('invocations',{...record,state:dispatched&&!receivedResponse?'uncertain':'failed_read'});
      emit(signal.aborted?'cancelled':'failed');
      throw new Error(dispatched&&!receivedResponse
        ?'MCP read outcome is uncertain; do not replay without reconciliation'
        :'MCP read failed; verify provider state before retrying');
    }
  }
  async close():Promise<void>{await Promise.all([...this.transports.values()].map(t=>t.close()));}
}
