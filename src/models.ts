export interface RelayModel { key:string; provider:'openrouter'|'ollama'; id:string; label:string; }
export interface RelayModels { defaultKey:string; models:RelayModel[]; ollama?:{baseUrl:string; modelIds:string[]}; }
const VALID_MODEL=/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,110}$/;

/** Only an administrator-defined, private inference endpoint can be registered. */
export function loadRelayModels(env:Record<string,string|undefined>):RelayModels {
  const cloud=env.RELAY_MODEL?.trim()||'cohere/north-mini-code:free';
  if(!VALID_MODEL.test(cloud)||!cloud.endsWith(':free'))throw new Error('OpenRouter model must use an explicit :free identifier');
  const models:RelayModel[]=[{key:'openrouter/'+cloud,provider:'openrouter',id:cloud,label:'OpenRouter · '+cloud}];
  const rawUrl=env.RELAY_OLLAMA_URL?.trim()||'';
  const requested=env.RELAY_OLLAMA_MODELS?.trim()||'';
  if(!rawUrl&&!requested)return {defaultKey:models[0].key,models};
  if(!rawUrl||!requested)throw new Error('RELAY_OLLAMA_URL and RELAY_OLLAMA_MODELS must be configured together');
  let url:URL;
  try { url=new URL(rawUrl); } catch { throw new Error('Invalid Ollama URL'); }
  const tailnet=url.protocol==='https:'&&url.hostname.endsWith('.ts.net')&&(!url.port||['8443','10000'].includes(url.port));
  const loopback=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((!tailnet&&!loopback)||url.username||url.password||url.search||url.hash||!['/v1','/v1/'].includes(url.pathname))
    throw new Error('Ollama URL must use private Tailscale HTTPS or localhost HTTP with /v1');
  const ids=requested.split(',').map(x=>x.trim());
  if(ids.length>8||ids.some(id=>!VALID_MODEL.test(id))||new Set(ids).size!==ids.length)throw new Error('Invalid Ollama model list');
  for(const id of ids)models.push({key:'ollama/'+id,provider:'ollama',id,label:'MacBook · '+id});
  return {defaultKey:models[0].key,models,ollama:{baseUrl:url.origin+'/v1',modelIds:ids}};
}
