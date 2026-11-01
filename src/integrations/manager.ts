import type { Store, Task } from '../store.js';
import { githubWriteRepositories } from './github-writes.js';
import { READ_TOOLS } from '../gateway.js';

export interface ProviderConfig {
  id:string; label:string; url:string; token:string; readTools:readonly string[];
  writeRepositories?:readonly string[];
}
export interface IntegrationStatus {
  id:string; label:string; enabled:boolean; configured:boolean;
  state:'disabled'|'unconfigured'|'unchecked'|'ready'|'offline'; availableTools:string[];
  availableWriteTools:string[];
}
export const GITHUB_READ=[
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
    token:env.RELAY_GITHUB_TOKEN??'',readTools:GITHUB_READ,
    writeRepositories:githubWriteRepositories(env.RELAY_GITHUB_WRITE_REPOS)}];
  // Atlas is a first-class trusted Pi MCP provider. Unlike arbitrary
  // operator-added hosts its endpoint already belongs to Relay's Atlas
  // awareness configuration and is validated by the existing Gateway.
  if(env.ATLAS_MCP_URL){
    const url=new URL(env.ATLAS_MCP_URL);
    if(url.username||url.password||url.search||url.hash||
        (url.protocol!=='https:'&&!(url.protocol==='http:'&&
          ['localhost','127.0.0.1','atlas'].includes(url.hostname))))
      throw new Error('Atlas native MCP requires HTTPS or a trusted local endpoint');
    providers.push({id:'atlas',label:'Atlas',url:url.toString(),
      token:env.ATLAS_MCP_TOKEN??'',
      // Atlas enforces read authorization; Relay projects verified resources.
      readTools:[...READ_TOOLS]});
  }
  const raw=env.RELAY_MCP_PROVIDERS || '[]';
  let configs:unknown;
  try {configs=JSON.parse(raw);}catch {throw new Error('Invalid RELAY_MCP_PROVIDERS');}
  if(!Array.isArray(configs)||configs.length>7)throw new Error('Invalid RELAY_MCP_PROVIDERS');
  const allowed=new Set((env.RELAY_MCP_HOST_ALLOWLIST||'').split(',').map(s=>s.trim()).filter(Boolean));
  for(const item of configs) {
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid MCP provider');
    const v=item as Record<string,unknown>;
    if(typeof v.id!=='string'||!validId(v.id)||(v.id==='github'||v.id==='atlas')||providers.some(p=>p.id===v.id)||
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
export type WriteApproval=(task:Task,invocationId:string,tool:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<void>;
/** Configuration only. Pi owns connections and discovery. */
export class ConnectionManager {
  constructor(private readonly configs:ProviderConfig[],private readonly enabled:(id:string)=>boolean) {}
  contains(id:string):boolean{return this.configs.some(p=>p.id===id);}
  nativeProviders(){return this.configs.map(config=>({config,enabled:()=>this.enabled(config.id)}));}
  list():IntegrationStatus[]{return this.configs.map(p=>({id:p.id,label:p.label,
    enabled:this.enabled(p.id),configured:!!p.token,
    state:!this.enabled(p.id)?'disabled':!p.token?'unconfigured':'unchecked',
    availableTools:this.enabled(p.id)?[...p.readTools]:[],
    availableWriteTools:this.enabled(p.id)&&p.writeRepositories?.length?['create_issue','add_issue_comment']:[]
  }));}
}
