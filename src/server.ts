import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { Store } from './store.js';
import { PiHarness } from './harness.js';
import { Engine } from './engine.js';
import { McpTransport } from './gateway.js';
import { createPlatform } from './platform.js';
import { loadRelayModels } from './models.js';

const modelRegistry=loadRelayModels(process.env);
const model=modelRegistry.models[0].id;
const token=process.env.RELAY_ACCESS_TOKEN || '';
if(token.length<24)throw new Error('RELAY_ACCESS_TOKEN must be 24+ characters');
if(!process.env.OPENROUTER_API_KEY)throw new Error('OPENROUTER_API_KEY is required');
if(!model.endsWith(':free'))throw new Error('Relay free-only mode requires RELAY_MODEL to end in :free');
const root=process.env.RELAY_DATA_DIR || join(process.cwd(),'.relay');
await mkdir(root,{recursive:true,mode:0o700});
const store=new Store(join(root,'relay.sqlite'));
const atlasUrl=process.env.ATLAS_MCP_URL?.trim() || '';
const atlasToken=process.env.ATLAS_MCP_TOKEN || '';
if (atlasUrl && !/^[a-f0-9]{64}$/.test(atlasToken))
  throw new Error('ATLAS_MCP_TOKEN must be a 32-byte random hexadecimal service token when ATLAS_MCP_URL is set');
if (!atlasUrl && atlasToken)
  throw new Error('ATLAS_MCP_URL is required when ATLAS_MCP_TOKEN is configured');
const atlas=atlasUrl ? new McpTransport(atlasUrl,atlasToken) : undefined;
const devTasks:unknown=JSON.parse(process.env.RELAY_ATLAS_DEV_TASKS || '{}');
if(!devTasks||typeof devTasks!=='object'||Array.isArray(devTasks)||Object.entries(devTasks).some(([id,names])=>!id.match(/^[a-f0-9-]{36}$/i)||!Array.isArray(names)||names.some(n=>typeof n!=='string'||!n.match(/^[a-z][a-z0-9_-]{0,63}$/))))throw new Error('Invalid development task allowlist');
const number=(key:string,fallback:number)=>Number(process.env[key]??fallback);
const engine=new Engine(store,new PiHarness(root,model,modelRegistry),{
  concurrency:number('RELAY_MAX_ACTIVE',1),queue:number('RELAY_MAX_QUEUED',64),
  sessionUsd:number('RELAY_SESSION_BUDGET_USD',0),globalUsd:number('RELAY_GLOBAL_BUDGET_USD',0),
  sessionTokens:number('RELAY_SESSION_TOKEN_LIMIT',0),reserveUsd:number('RELAY_RUN_RESERVATION_USD',0),
  maxRunMs:number('RELAY_RUN_TIMEOUT_MS',600000)
},atlas,devTasks as Record<string,string[]>,modelRegistry);
const server=createPlatform(engine,token,join(dirname(fileURLToPath(import.meta.url)),'public'),model,modelRegistry);
server.listen(Number(process.env.PORT||8765),process.env.HOST||'0.0.0.0',()=>{
  const address=server.address();console.log('Relay started on port '+(address&&typeof address==='object'?address.port:'unknown'));engine.start();
});
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;server.close();
  const force=setTimeout(()=>process.exit(1),10000);force.unref();
  await engine.stop();await atlas?.close().catch(()=>{});store.close();clearTimeout(force);
}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
