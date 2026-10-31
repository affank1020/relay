import { createHash } from 'node:crypto';

export interface GitSkillSource {owner:string;repo:string;commit:string;path:string}
export interface ReviewedGitSkill extends GitSkillSource {
  id:string;name:string;description:string;version:string;sha256:string;installedAt:string;
}
export interface GitSkillCandidate {
  source:GitSkillSource;name:string;description:string;version:string;
  sha256:string;content:string;
}
export class SkillPackageError extends Error {
  constructor(message:string,readonly status=400){super(message);this.name='SkillPackageError';}
}
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
export {sha256 as skillDigest};
const validName=(name:string)=>/^[a-z][a-z0-9-]{1,47}$/.test(name);
const validPart=(part:string)=>/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(part)&&part!=='.'&&part!=='..';
const validPath=(path:string)=>{
  const parts=path.split('/');
  return parts.length<=8&&parts.at(-1)==='SKILL.md' &&
    parts.slice(0,-1).every(validPart) && path.length<=400;
};
export function validSource(v:unknown):v is GitSkillSource {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const s=v as Record<string,unknown>;
  return Object.keys(s).length===4 && ['owner','repo','commit','path'].every(k=>typeof s[k]==='string') &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(s.owner as string) &&
    validPart(s.repo as string) &&
    /^[0-9a-f]{40}$/.test(s.commit as string) &&
    validPath(s.path as string);
}
export function validRecord(v:unknown):v is ReviewedGitSkill {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const r=v as Record<string,unknown>;
  return Object.keys(r).sort().join(',')===
    'commit,description,id,installedAt,name,owner,path,repo,sha256,version' &&
    validSource({owner:r.owner,repo:r.repo,commit:r.commit,path:r.path}) &&
    typeof r.id==='string'&&/^git-[0-9a-f]{32}$/.test(r.id) &&
    typeof r.name==='string'&&validName(r.name) &&
    typeof r.description==='string'&&r.description.length>=8&&r.description.length<=200 &&
    typeof r.version==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+$/.test(r.version) &&
    typeof r.sha256==='string'&&/^[0-9a-f]{64}$/.test(r.sha256) &&
    typeof r.installedAt==='string'&&!Number.isNaN(Date.parse(r.installedAt));
}
export function parseSkill(text:string):{name:string;description:string;version:string}{
  if(!text||Buffer.byteLength(text,'utf8')>32_768||text.includes('\u0000')||
    /<\/?trusted_skill\b/i.test(text))throw new SkillPackageError('Unsupported Skill instructions');
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if(!match||match[1].length>2048)throw new SkillPackageError('Invalid Skill frontmatter');
  const lines=match[1].split(/\r?\n/);
  const properties=new Map<string,string>();
  for(const line of lines){
    const pair=/^([a-zA-Z][a-zA-Z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if(!pair||properties.has(pair[1]))throw new SkillPackageError('Invalid Skill frontmatter');
    properties.set(pair[1],pair[2]);
  }
  const name=properties.get('name')??'';
  const description=properties.get('description')??'';
  const version=properties.get('version')??'1.0.0';
  if(!validName(name)||description.length<8||description.length>200||
    /[\r\n<>]/.test(description)||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    throw new SkillPackageError('Invalid Skill metadata');
  return {name,description,version};
}
type Fetcher=typeof fetch;
async function limitedJson(response:Response):Promise<unknown> {
  if(!response.ok)throw new SkillPackageError('Pinned public GitHub Skill could not be fetched',502);
  const reader=response.body?.getReader();
  if(!reader)throw new SkillPackageError('Missing GitHub response',502);
  const chunks:Uint8Array[]=[];
  let bytes=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      bytes+=next.value.length;
      if(bytes>64_000){
        await reader.cancel().catch(()=>{});
        throw new SkillPackageError('GitHub Skill response too large',502);
      }
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new SkillPackageError('Malformed GitHub Skill response',502);}
}
export async function fetchPinnedGitSkill(input:unknown,fetcher:Fetcher=fetch):Promise<GitSkillCandidate>{
  if(!validSource(input))throw new SkillPackageError('Provide a pinned GitHub owner, repo, full commit SHA and SKILL.md path');
  const segments=input.path.split('/').map(encodeURIComponent).join('/');
  const url='https://api.github.com/repos/'+encodeURIComponent(input.owner)+'/'+
    encodeURIComponent(input.repo)+'/contents/'+segments+'?ref='+input.commit;
  let response:Response;
  try{
    response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{Accept:'application/vnd.github+json','User-Agent':'Relay-reviewed-skills'}});
  }catch{throw new SkillPackageError('Pinned public GitHub Skill could not be fetched',502);}
  const value=await limitedJson(response);
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new SkillPackageError('Malformed GitHub Skill response',502);
  const data=value as Record<string,unknown>;
  if(data.type!=='file'||data.encoding!=='base64'||data.name!=='SKILL.md'||
    typeof data.content!=='string')throw new SkillPackageError('Expected a single GitHub SKILL.md file',502);
  const compact=data.content.replace(/\r?\n/g,'');
  if(compact.length>44_000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
    throw new SkillPackageError('Invalid Skill encoding',502);
  const buffer=Buffer.from(compact,'base64');
  if(buffer.length>32_768)throw new SkillPackageError('Skill file exceeds size limit',502);
  let content:string;
  try{content=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}
  catch{throw new SkillPackageError('Skill is not UTF-8',502);}
  const meta=parseSkill(content);
  return {source:input,...meta,sha256:sha256(content),content};
}
