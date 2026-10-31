export interface RelayModel { key:string; provider:'openrouter'|'ollama'; id:string; label:string; }
export interface RelayModels { defaultKey:string; models:RelayModel[]; ollama?:{baseUrl:string; modelIds:string[]; online?:boolean; lastChecked?:number}; }
const VALID_MODEL=/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,110}$/;
const MAX_LOCAL_MODELS=8;
const DISCOVERY_INTERVAL_MS=15_000;
const pending=new WeakMap<RelayModels,Promise<void>>();

/** Only an administrator-defined, private inference endpoint can be registered. */
export function loadRelayModels(env:Record<string,string|undefined>):RelayModels {
  const cloud=env.RELAY_MODEL?.trim()||'cohere/north-mini-code:free';
  if(!VALID_MODEL.test(cloud)||!cloud.endsWith(':free'))throw new Error('OpenRouter model must use an explicit :free identifier');
  const models:RelayModel[]=[{key:'openrouter/'+cloud,provider:'openrouter',id:cloud,label:'OpenRouter · '+cloud}];
  const rawUrl=env.RELAY_OLLAMA_URL?.trim()||'';
  const requested=env.RELAY_OLLAMA_MODELS?.trim()||'';
  if(!rawUrl&&!requested)return {defaultKey:models[0].key,models};
  if(!rawUrl)throw new Error('RELAY_OLLAMA_URL is required when RELAY_OLLAMA_MODELS is configured');
  let url:URL;
  try { url=new URL(rawUrl); } catch { throw new Error('Invalid Ollama URL'); }
  const tailnet=url.protocol==='https:'&&url.hostname.endsWith('.ts.net')&&(!url.port||['8443','10000'].includes(url.port));
  const loopback=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((!tailnet&&!loopback)||url.username||url.password||url.search||url.hash||!['/v1','/v1/'].includes(url.pathname))
    throw new Error('Ollama URL must use private Tailscale HTTPS or localhost HTTP with /v1');
  // The legacy list seeds the catalog while the Mac is offline; discovery
  // replaces it with the live installed models whenever Ollama is reachable.
  const ids=requested?requested.split(',').map(x=>x.trim()):[];
  if(ids.length>MAX_LOCAL_MODELS||ids.some(id=>!VALID_MODEL.test(id))||new Set(ids).size!==ids.length)throw new Error('Invalid Ollama model list');
  for(const id of ids)models.push({key:'ollama/'+id,provider:'ollama',id,label:'MacBook · '+id});
  return {defaultKey:models[0].key,models,ollama:{baseUrl:url.origin+'/v1',modelIds:ids}};
}

/** Bounded, deduplicated, server-side model discovery; never accepts client URLs.
 * Failed probes retain the last catalog without enabling cloud fallback.
 */
export async function refreshOllamaModels(registry:RelayModels, request:typeof fetch=fetch, now=Date.now()):Promise<void> {
  const local=registry.ollama;
  if(!local)return;
  const running=pending.get(registry);
  if(running)return running;
  if(local.lastChecked!==undefined&&now-local.lastChecked>=0&&now-local.lastChecked<DISCOVERY_INTERVAL_MS)return;
  const job=(async()=>{
    local.lastChecked=now;
    try {
      const response=await request(local.baseUrl+'/models',{signal:AbortSignal.timeout(4500)});
      if(!response.ok)throw new Error('Ollama unreachable');
      const contentLength=Number(response.headers.get('content-length')||0);
      if(contentLength>65536)throw new Error('Ollama model catalog too large');
      const payloadText=await response.text();
      if(payloadText.length>65536)throw new Error('Ollama model catalog too large');
      const payload:unknown=JSON.parse(payloadText);
      const entries=(payload as {data?:unknown})?.data;
      if(!Array.isArray(entries)||entries.length>256)throw new Error('Invalid Ollama model catalog');
      const ids:string[]=[];
      for(const entry of entries) {
        const id=(entry as {id?:unknown}|null)?.id;
        if(typeof id==='string'&&VALID_MODEL.test(id)&&!ids.includes(id)&&ids.length<MAX_LOCAL_MODELS)ids.push(id);
      }
      const cloud=registry.models.filter(model=>model.provider!=='ollama');
      registry.models.splice(0,registry.models.length,...cloud,...ids.map(id=>({key:'ollama/'+id,provider:'ollama' as const,id,label:'MacBook · '+id})));
      local.modelIds=ids;
      local.online=true;
    } catch {
      local.online=false;
    }
  })();
  pending.set(registry,job);
  try {await job;} finally {if(pending.get(registry)===job)pending.delete(registry);}
}
