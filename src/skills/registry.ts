import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parseSkill, type ReviewedGitSkill } from './git.js';

export interface SkillInfo {
  id:string;name:string;description:string;source:'bundled'|'git';version:string;
  revision:string|null;enabled:boolean;installed:boolean;loadFailure:string|null;
  sourceRef?:string;
}
const TRUSTED=[
  {id:'prepare-pr',name:'prepare-pr',description:'Author-side pull request preparation and validation',version:'1.0.0'},
  {id:'code-reviewer',name:'code-reviewer',description:'Evidence-based independent code review',version:'1.0.0'}
] as const;
const sha256=(content:string)=>createHash('sha256').update(content).digest('hex');
export class TrustedSkills {
  constructor(private readonly directory:string,private enabled:(id:string)=>boolean,
    private readonly installedDirectory?:string,
    private readonly reviewed:()=>Record<string,ReviewedGitSkill>=()=>({})) {}
  private entries(){
    return [
      ...TRUSTED.map(s=>({...s,source:'bundled' as const})),
      ...Object.values(this.reviewed()).map(s=>({...s,source:'git' as const}))
    ];
  }
  private path(id:string,source:'bundled'|'git'){
    return join(source==='bundled'?this.directory:this.installedDirectory??'',id,'SKILL.md');
  }
  private async validated(skill:ReturnType<TrustedSkills['entries']>[number]):Promise<string> {
    const rootDir=skill.source==='bundled'?this.directory:this.installedDirectory;
    if(!rootDir)throw new Error('missing');
    const rootStat=await lstat(rootDir);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('unsafe directory');
    const root=await realpath(rootDir);
    const dir=join(rootDir,skill.id);
    const folder=await lstat(dir);
    if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('unsafe package');
    const file=this.path(skill.id,skill.source);
    const real=await realpath(file);
    const stat=await lstat(file);
    if(!real.startsWith(root+sep)||!stat.isFile()||stat.isSymbolicLink()||stat.size>32_768)
      throw new Error('untrusted file');
    const content=await readFile(file,'utf8');
    const meta=parseSkill(content);
    if(meta.name!==skill.name ||
      (skill.source==='git' && (meta.description!==skill.description||meta.version!==skill.version)))
      throw new Error('mismatched metadata');
    if(skill.source==='git' && sha256(content)!==skill.sha256)throw new Error('modified reviewed Skill');
    return content;
  }
  async list():Promise<SkillInfo[]> {
    return Promise.all(this.entries().map(async skill=>{
      let revision:string|null=null,loadFailure:string|null=null;
      try{revision=sha256(await this.validated(skill));}
      catch{loadFailure='Trusted Skill package missing, modified or unsafe';}
      return {id:skill.id,name:skill.name,description:skill.description,
        source:skill.source,version:skill.version,revision,
        installed:!loadFailure,enabled:!loadFailure&&this.enabled(skill.id),loadFailure,
        ...(skill.source==='git'?{sourceRef:skill.owner+'/'+skill.repo+'@'+skill.commit.slice(0,12)+' / '+skill.path}:{})};
    }));
  }
  async permittedPaths():Promise<Array<{name:string;path:string}>> {
    const list=await this.list();
    return list.filter(s=>s.enabled).map(s=>({name:s.name,path:this.path(s.id,s.source)}));
  }
  async promptContent():Promise<string> {
    const listed=await this.list();
    const parts:string[]=[];
    for(const skill of listed.filter(s=>s.enabled)){
      const entry=this.entries().find(s=>s.id===skill.id);
      if(!entry)throw new Error('Trusted Skill removed during loading');
      const content=await this.validated(entry);
      if(sha256(content)!==skill.revision)
        throw new Error('Trusted Skill changed during loading');
      parts.push('<trusted_skill name="'+skill.name+'">\n'+content+'\n</trusted_skill>');
    }
    return parts.join('\n\n');
  }
  contains(id:string):boolean {return this.entries().some(s=>s.id===id);}
  containsName(name:string):boolean{return this.entries().some(s=>s.name===name);}
}
