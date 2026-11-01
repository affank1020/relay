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
  // One coherent, validated resource snapshot per Pi inference. A concurrent
  // disable/remove cannot make metadata and instructions come from different
  // admission decisions. Running tasks may finish with an earlier snapshot.
  async snapshot(maxInstructionBytes=384*1024):Promise<{
    paths:Array<{name:string;path:string}>;instructions:string;skipped:string[];
    // The same validated bytes used for discovery, for Pi's on-demand reader.
    // Never reread a path after the admission snapshot.
    documents:Record<string,string>;
  }> {
    // UTF-8 byte length is a conservative upper bound for text token usage:
    // never assume a 4-bytes-per-token average for arbitrary Skill content.
    // PiHarness supplies the selected model's context reservation. The upper
    // limit here is only a defense-in-depth bound above the combined maximum
    // for eight 32KiB Git Skills plus bundled Skills, not a per-model ceiling.
    const budget=Number.isFinite(maxInstructionBytes)?
      Math.max(0,Math.min(384*1024,Math.floor(maxInstructionBytes))):0;
    const permitted=this.entries().filter(skill=>this.enabled(skill.id));
    const paths:Array<{name:string;path:string}>=[];
    const parts:string[]=[];
    const documents:Record<string,string>=Object.create(null) as Record<string,string>;
    const skipped:string[]=[];
    let used=0;
    for(const skill of permitted){
      const content=await this.validated(skill);
      const wrapped='<trusted_skill name="'+skill.name+'">\n'+content+'\n</trusted_skill>';
      const size=Buffer.byteLength(wrapped,'utf8')+(parts.length?2:0);
      if(size>budget-used){
        skipped.push(skill.name);
        continue;
      }
      used+=size;
      paths.push({name:skill.name,path:this.path(skill.id,skill.source)});
      documents[skill.name]=content;
      parts.push(wrapped);
    }
    return {paths,instructions:parts.join('\n\n'),skipped,documents};
  }
  async permittedPaths():Promise<Array<{name:string;path:string}>> {
    // Missing/modified packages are silently omitted in status and discovery;
    // the inference snapshot above deliberately fails rather than loading a
    // partially trusted set.
    const list=await this.list();
    return list.filter(s=>s.enabled).map(s=>({name:s.name,path:this.path(s.id,s.source)}));
  }
  async promptContent():Promise<string> {
    const list=await this.list();
    const parts:string[]=[];
    for(const skill of list.filter(s=>s.enabled)){
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
