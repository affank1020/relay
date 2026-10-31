import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

export interface SkillInfo {
  id:string; name:string; description:string; source:'bundled'; version:string;
  revision:string|null; enabled:boolean; installed:boolean; loadFailure:string|null;
}
const TRUSTED=[
  {id:'prepare-pr',name:'prepare-pr',description:'Author-side pull request preparation and validation',version:'1.0.0'},
  {id:'code-reviewer',name:'code-reviewer',description:'Evidence-based independent code review',version:'1.0.0'}
] as const;
export class TrustedSkills {
  constructor(private readonly directory:string,private enabled:(id:string)=>boolean) {}
  async list():Promise<SkillInfo[]> {
    const root=await realpath(this.directory).catch(()=>null);
    return Promise.all(TRUSTED.map(async skill=>{
      const file=join(this.directory,skill.id,'SKILL.md');
      let revision:string|null=null,loadFailure:string|null=null;
      try {
        if(!root)throw new Error('missing');
        const real=await realpath(file);
        const stat=await lstat(file);
        if(!real.startsWith(root+sep)||!stat.isFile()||stat.isSymbolicLink())throw new Error('untrusted');
        const content=await readFile(file,'utf8');
        if(Buffer.byteLength(content)>32_768 || !content.startsWith('---\n') ||
           !new RegExp('^name: '+skill.name+'$','m').test(content) ||
           !/^description: [^\n]{8,200}$/m.test(content))
          throw new Error('invalid');
        revision=createHash('sha256').update(content).digest('hex');
      }catch {loadFailure='Trusted Skill package missing, invalid or unsafe';}
      return {...skill,source:'bundled' as const,revision,installed:!loadFailure,
        enabled:!loadFailure&&this.enabled(skill.id),loadFailure};
    }));
  }
  async permittedPaths():Promise<Array<{name:string;path:string}>> {
    const list=await this.list();
    return list.filter(s=>s.enabled).map(s=>({name:s.name,path:join(this.directory,s.id,'SKILL.md')}));
  }
  contains(id:string):boolean {return TRUSTED.some(s=>s.id===id);}
}