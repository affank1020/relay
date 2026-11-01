import { mkdir, lstat, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuredExtensions } from './extensions.js';
import { TrustedSkills } from './skills/registry.js';
import { fetchPinnedGitSkill, skillDigest, validRecord, SkillPackageError,
  type GitSkillCandidate, type ReviewedGitSkill } from './skills/git.js';
import { configuredProviders, ConnectionManager, type ProviderConfig } from './integrations/manager.js';
import type { Store, Task } from './store.js';
import type { NativeMcpRun } from './pi-native-mcp.js';

interface Settings {
  version:1; skills:Record<string,boolean>; integrations:Record<string,boolean>;
  reviewedSkills?:Record<string,ReviewedGitSkill>;
}
const empty=():Settings=>({version:1,skills:{},integrations:{},reviewedSkills:{}});
interface StagedPreview { candidate:GitSkillCandidate; expires:number }
export class CapabilityRegistry {
  readonly skills:TrustedSkills;
  readonly connections:ConnectionManager;
  private settings:Settings=empty();
  private writes:Promise<void>=Promise.resolve();
  private readonly file:string;
  private readonly installedDirectory:string;
  private readonly previews=new Map<string,StagedPreview>();
  constructor(root:string,bundledSkills:string,providers:ProviderConfig[],
    private readonly fetcher:typeof fetch=fetch){
    this.file=join(root,'capabilities.json');
    this.installedDirectory=join(root,'trusted-git-skills');
    this.skills=new TrustedSkills(bundledSkills,id=>this.settings.skills[id]===true,
      this.installedDirectory,()=>this.settings.reviewedSkills??{});
    this.connections=new ConnectionManager(providers,id=>this.settings.integrations[id]===true);
  }
  static async open(root:string,bundledSkills:string,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
    const instance=new CapabilityRegistry(root,bundledSkills,configuredProviders(env),fetcher);
    try{
      const data=JSON.parse(await readFile(instance.file,'utf8')) as Settings;
      if(!data||data.version!==1||!data.skills||!data.integrations||
         typeof data.skills!=='object'||Array.isArray(data.skills)||
         typeof data.integrations!=='object'||Array.isArray(data.integrations)||
         Object.values({...data.skills,...data.integrations}).some(v=>typeof v!=='boolean'))
        throw new Error('Invalid capability settings');
      const reviewed=data.reviewedSkills??{};
      if(!reviewed||typeof reviewed!=='object'||Array.isArray(reviewed)||
        Object.keys(reviewed).length>8||
        Object.entries(reviewed).some(([id,record])=>!validRecord(record)||id!==record.id)||
        new Set(Object.values(reviewed).map(r=>r.name)).size!==Object.keys(reviewed).length ||
        Object.values(reviewed).some(r=>['prepare-pr','code-reviewer'].includes(r.name)))
        throw new Error('Invalid reviewed Skill registry');
      data.reviewedSkills=reviewed;
      instance.settings=data;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')
        throw new Error('Capability settings invalid; refusing to enable tools');
    }
    return instance;
  }
  private enqueue<T>(operation:()=>Promise<T>):Promise<T>{
    const work=this.writes.then(operation);
    this.writes=work.then(()=>{},()=>{});
    return work;
  }
  private async persist(next:Settings):Promise<void>{
    const temp=join(dirname(this.file),'.capabilities-'+randomUUID()+'.tmp');
    try{
      await writeFile(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});
      await rename(temp,this.file);
      this.settings=next;
    }catch{throw new SkillPackageError('Could not persist capability settings',503);}
    finally{await unlink(temp).catch(()=>{});}
  }
  async list(){return {extensions:configuredExtensions().names,skills:await this.skills.list(),integrations:this.connections.list()};}
  async skillPaths(){return this.skills.permittedPaths();}
  nativeMcp(task:Task,store:Store):NativeMcpRun {
    return {task,store,providers:this.connections.nativeProviders()};
  }
  async update(kind:'skills'|'integrations',id:string,enabled:boolean){
    if(typeof enabled!=='boolean'||!(kind==='skills'?this.skills.contains(id):this.connections.contains(id)))
      throw new SkillPackageError('Unknown capability',404);
    await this.enqueue(async()=>{
      // Recheck after the queued mutations. An uninstall must not leave a
      // stale enable/disable flag for a now-unknown Skill ID.
      if(!(kind==='skills'?this.skills.contains(id):this.connections.contains(id)))
        throw new SkillPackageError('Unknown capability',404);
      if(kind==='skills'&&enabled){
        const status=(await this.skills.list()).find(s=>s.id===id);
        if(!status?.installed)throw new SkillPackageError('Skill package is missing or modified',409);
      }
      const next:Settings={...this.settings,
        skills:{...this.settings.skills},integrations:{...this.settings.integrations}};
      next[kind][id]=enabled;
      await this.persist(next);
    });
  }
  async previewGitSkill(input:unknown){
    const candidate=await fetchPinnedGitSkill(input,this.fetcher);
    if(this.skills.containsName(candidate.name))
      throw new SkillPackageError('A Skill with this name is already installed',409);
    // A preview is untrusted text and grants no permissions or persistence.
    for(const [id,preview] of this.previews)if(preview.expires<Date.now())this.previews.delete(id);
    if(this.previews.size>=4)this.previews.delete(this.previews.keys().next().value!);
    const previewId=randomUUID();
    this.previews.set(previewId,{candidate,expires:Date.now()+10*60_000});
    return {...candidate,previewId};
  }
  async installGitSkill(previewId:unknown,sha256:unknown,acknowledged:unknown){
    if(typeof previewId!=='string'||!/^[a-f0-9-]{36}$/.test(previewId)||
      typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||acknowledged!==true)
      throw new SkillPackageError('Confirm the exact reviewed Skill fingerprint');
    return this.enqueue(async()=>{
      const staged=this.previews.get(previewId);
      // One-time use; it cannot be replayed after success or failure.
      this.previews.delete(previewId);
      if(!staged||staged.expires<Date.now()||sha256!==staged.candidate.sha256)
        throw new SkillPackageError('Skill preview expired or fingerprint does not match',409);
      const candidate=staged.candidate;
      if(Object.keys(this.settings.reviewedSkills??{}).length>=8)
        throw new SkillPackageError('Reviewed Skill limit reached',409);
      if(this.skills.containsName(candidate.name))
        throw new SkillPackageError('A Skill with this name is already installed',409);
      if(skillDigest(candidate.content)!==candidate.sha256)
        throw new SkillPackageError('Skill changed after review',409);
      const id='git-'+randomUUID().replace(/-/g,'');
      const record:ReviewedGitSkill={...candidate.source,id,name:candidate.name,
        description:candidate.description,version:candidate.version,
        sha256:candidate.sha256,installedAt:new Date().toISOString()};
      const folder=join(this.installedDirectory,id);
      let created=false;
      try{
        await mkdir(this.installedDirectory,{recursive:true,mode:0o700});
        const stat=await lstat(this.installedDirectory);
        if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe Skill directory');
        await mkdir(folder,{mode:0o700});
        created=true;
        await writeFile(join(folder,'SKILL.md'),candidate.content,{mode:0o600,flag:'wx'});
        await this.persist({...this.settings,
          skills:{...this.settings.skills,[id]:false},
          reviewedSkills:{...this.settings.reviewedSkills,[id]:record}});
      }catch(error){
        // Do not remove a pre-existing colliding directory we did not create.
        if(created)await rm(folder,{recursive:true,force:true}).catch(()=>{});
        if(error instanceof SkillPackageError)throw error;
        throw new SkillPackageError('Could not store reviewed Skill',503);
      }
      return record;
    });
  }
  async uninstallGitSkill(id:string){
    return this.enqueue(async()=>{
      if(!Object.hasOwn(this.settings.reviewedSkills??{},id))
        throw new SkillPackageError('Reviewed Skill not found',404);
      const reviewed={...this.settings.reviewedSkills};
      delete reviewed[id];
      const skills={...this.settings.skills};
      delete skills[id];
      // First remove authority from persistent settings, then clean up bytes.
      await this.persist({...this.settings,reviewedSkills:reviewed,skills});
      // A malformed local root must never turn cleanup into deletion outside
      // Relay's own persisted Skill directory.
      const rootStat=await lstat(this.installedDirectory).catch(()=>null);
      if(rootStat?.isDirectory()&&!rootStat.isSymbolicLink())
        await rm(join(this.installedDirectory,id),{recursive:true,force:true}).catch(()=>{});
    });
  }
  async close(){await this.writes;this.previews.clear();}
}
