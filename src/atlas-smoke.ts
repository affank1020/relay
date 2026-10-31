import type { AtlasTransport } from './gateway.js';
import { observeAtlasDetailResult } from './atlas-awareness-details.js';
import { READ_TOOLS } from './gateway.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record=(value:unknown):Record<string,unknown>|undefined=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

export interface AtlasSmokeReport {
  /** Counts and statuses only; no project names, record bodies or MCP payloads. */
  discoveredTools:number;
  allowedReadTools:number;
  coreStatus:'verified';
  codeReviews:'verified'|'not_advertised';
  projectRead:'verified'|'not_requested'|'not_advertised';
}

/**
 * Explicit operator-invoked smoke, never automatic on startup. No writes.
 * Exercise the actual MCP transport/service credential instead of fixtures.
 */
export async function verifyAtlasReadOnlyConnection(
  transport:Pick<AtlasTransport,'list'|'call'>,options:{projectId?:string}={}
):Promise<AtlasSmokeReport> {
  if(options.projectId!==undefined&&!UUID.test(options.projectId))
    throw new Error('Invalid optional smoke Project ID');
  const discovered=await transport.list();
  const names=new Set<string>();
  for(const tool of discovered){
    if(!tool||typeof tool.name!=='string')throw new Error('Invalid Atlas tool catalogue');
    if(names.has(tool.name))throw new Error('Duplicate Atlas tool in catalogue');
    names.add(tool.name);
  }
  const read=async(name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>=>{
    if(!READ_TOOLS.has(name)||!names.has(name))throw new Error('Required Atlas read is not admitted');
    const response=record(await transport.call(name,args,AbortSignal.timeout(30000)));
    if(!response||response.isError===true)throw new Error('Atlas read-only operation failed');
    const result=record(record(response.structuredContent)?.result);
    if(!result)throw new Error('Atlas returned no structured read evidence');
    return result;
  };
  const status=await read('get_atlas_status',{});
  if(Object.keys(status).length===0)throw new Error('Atlas status was empty');
  let projectRead:AtlasSmokeReport['projectRead']='not_requested';
  if(options.projectId){
    if(names.has('get_project')){
      const value=await read('get_project',{projectId:options.projectId});
      if(!observeAtlasDetailResult('get_project',{projectId:options.projectId},value))
        throw new Error('Atlas project read identity did not match');
      projectRead='verified';
    }else projectRead='not_advertised';
  }
  let codeReviews:AtlasSmokeReport['codeReviews']='not_advertised';
  if(names.has('code_reviews_overview')){
    const value=await read('code_reviews_overview',{});
    if(!observeAtlasDetailResult('code_reviews_overview',{},value))
      throw new Error('Atlas Code Reviews overview did not match the reviewed contract');
    codeReviews='verified';
  }
  return {discoveredTools:names.size,
    allowedReadTools:[...names].filter(name=>READ_TOOLS.has(name)).length,
    coreStatus:'verified',codeReviews,projectRead};
}
