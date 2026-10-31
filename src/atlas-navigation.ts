import type { AtlasCheckoutView } from './atlas-awareness.js';
import type { AtlasDetail } from './atlas-awareness-details.js';

/**
 * Atlas Web's current, verified hash routes (apps/web/src/App.tsx).
 * Do not invent a record/checkout-specific route that Atlas doesn't support.
 * Only the operator-configured web origin, never MCP response data, is used.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonicalId=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
export interface AtlasNavigationLink { href:string; label:string; }

export function parseAtlasWebOrigin(input:unknown):string|undefined {
  if(input===undefined||input===null||input==='')return undefined;
  if(typeof input!=='string'||input.trim()!==input||/\s/.test(input))throw new Error('Invalid ATLAS_WEB_ORIGIN');
  let url:URL;
  try{url=new URL(input);}catch{throw new Error('Invalid ATLAS_WEB_ORIGIN');}
  // URL normalisation can collapse /extra/.. into /: reject it *before*
  // trusting the normalised pathname as proof this was an origin-only input.
  const parts=/^[a-z]+:\/\/[^/?#]+(.*)$/i.exec(input);
  if(!parts||(parts[1]!==''&&parts[1]!=='/')||input.includes('\\'))
    throw new Error('ATLAS_WEB_ORIGIN must be an origin, not a route');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&local))||
    url.username||url.password||url.pathname!=='/'||url.search||url.hash||
    !url.hostname)throw new Error('ATLAS_WEB_ORIGIN must be a HTTPS origin (or localhost development origin), without path, credentials or query');
  return url.origin;
}
function link(origin:string|undefined,hash:string,label:string):AtlasNavigationLink|undefined {
  if(!origin)return undefined;
  let safe:string|undefined;
  try{safe=parseAtlasWebOrigin(origin);}catch{return undefined;}
  return safe?{href:safe+'/'+hash,label}:undefined;
}

export function atlasCheckoutLink(origin:string|undefined,view:Pick<AtlasCheckoutView,'checkoutId'|'projectId'>):
  AtlasNavigationLink|undefined {
  if(!canonicalId(view.checkoutId))return undefined;
  if(view.projectId&&canonicalId(view.projectId))
    return link(origin,'#/projects/'+view.projectId+'/workspaces','Open project workspaces');
  return link(origin,'#/workspaces','Open workspaces');
}
export function atlasNodeLink(origin:string|undefined,nodeId:unknown):AtlasNavigationLink|undefined {
  if(!canonicalId(nodeId))return undefined;
  return link(origin,'#/nodes','Open Nodes');
}

export function atlasDetailLink(origin:string|undefined,detail:AtlasDetail):AtlasNavigationLink|undefined {
  switch(detail.kind){
    case 'project':
      return canonicalId(detail.projectId)?
        link(origin,'#/projects/'+detail.projectId,'Open project'):undefined;
    case 'store':
    case 'record':
      return canonicalId(detail.projectId)&&canonicalId(detail.storeId)?
        link(origin,'#/projects/'+detail.projectId+'/stores/'+detail.storeId+'/records',
          detail.kind==='record'?'Open containing store':'Open store'):undefined;
    case 'review_overview':
      return canonicalId(detail.projectId)?
        link(origin,'#/applications/code-reviews','Open Code Reviews'):undefined;
    case 'review_pr':
    case 'review_findings':
      return link(origin,'#/applications/code-reviews','Open Code Reviews');
  }
}
