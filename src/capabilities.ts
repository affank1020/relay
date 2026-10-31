import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TrustedSkills } from './skills/registry.js';
import { configuredProviders, ConnectionManager, type ProviderConfig, type ProviderTransport } from './integrations/manager.js';
import type { Store, Task } from './store.js';

interface Settings {version:1;skills:Record<string,boolean>;integrations:Record<string,boolean>}
const empty=():Settings=>({version:1,skills:{},integrations:{}});
export class CapabilityRegistry {
  readonly skills:TrustedSkills;
  readonly connections:ConnectionManager;
  private settings:Settings=empty();
  private writes=Promise.resolve();
  private readonly file:string;
  constructor(root:string,bundledSkills:string,providers:ProviderConfig[],
    makeTransport?:(config:ProviderConfig)=>ProviderTransport){
    this.file=join(root,'capabilities.json');
    this.skills=new TrustedSkills(bundledSkills,id=>this.settings.skills[id]===true);
    this.connections=new ConnectionManager(providers,id=>this.settings.integrations[id]===true,makeTransport);
  }
  static async open(root:string,bundledSkills:string,env:NodeJS.ProcessEnv=process.env){
    const instance=new CapabilityRegistry(root,bundledSkills,configuredProviders(env));
    try{
      const data=JSON.parse(await readFile(instance.file,'utf8')) as Settings;
      if(!data||data.version!==1||!data.skills||!data.integrations||
         typeof data.skills!=='object'||typeof data.integrations!=='object'||
         Object.values({...data.skills,...data.integrations}).some(v=>typeof v!=='boolean'))
        throw new Error('Invalid capability settings');
      instance.settings=data;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Capability settings invalid; refusing to enable tools');
    }
    return instance;
  }
  async list(){return {skills:await this.skills.list(),integrations:this.connections.list()};}
  async skillPaths(){return this.skills.permittedPaths();}
  async tools(task:Task,store:Store,signal:AbortSignal){return this.connections.tools(task,store,signal);}
  async update(kind:'skills'|'integrations',id:string,enabled:boolean){
    if(typeof enabled!=='boolean'||!(kind==='skills'?this.skills.contains(id):this.connections.contains(id)))
      throw new Error('Unknown capability');
    const work=this.writes.then(async()=>{
      const next:Settings={version:1,skills:{...this.settings.skills},
        integrations:{...this.settings.integrations}};
      next[kind][id]=enabled;
      const temp=join(dirname(this.file),'.capabilities-'+randomUUID()+'.tmp');
      try{await writeFile(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(temp,this.file);}
      catch{throw new Error('Could not persist capability choice');}
      this.settings=next;
    });
    this.writes=work.catch(()=>{});
    await work;
  }
  async close(){await this.writes;await this.connections.close();}
}
