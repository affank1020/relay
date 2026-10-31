import type { AtlasContext, AtlasProject, AtlasCheckout } from './atlas-context.js';

interface ContextSession { id:string; busy:boolean; atlasContext?:AtlasContext|null; }
type Api=(path:string,options?:RequestInit)=>Promise<Response>;
const element=<T extends HTMLElement>(tag:string,className:string,label?:string):T=>{
  const node=document.createElement(tag) as T;node.className=className;
  if(label!==undefined)node.textContent=label;
  return node;
};
function option(select:HTMLSelectElement,id:string,label:string,disabled=false){
  const el=document.createElement('option');el.value=id;el.textContent=label;el.disabled=disabled;select.append(el);
}
export class AtlasContextPicker {
  private session:ContextSession|null=null;
  private generation=0;
  private readonly trigger=element<HTMLButtonElement>('button','context-trigger');
  private readonly panel=element<HTMLDivElement>('div','context-popover');
  private readonly project=element<HTMLSelectElement>('select','context-select');
  private readonly checkout=element<HTMLSelectElement>('select','context-select');
  private readonly status=element<HTMLParagraphElement>('p','context-status');
  private readonly save=element<HTMLButtonElement>('button','context-save','Save');
  private readonly checkoutField=element<HTMLDivElement>('div','context-field');
  private projects:AtlasProject[]=[];
  private checkouts:AtlasCheckout[]=[];
  private loading=false;
  constructor(root:HTMLElement,private api:Api,private notify:(e:unknown)=>void){
    this.trigger.type='button';this.trigger.title='Select Atlas context';this.trigger.setAttribute('aria-expanded','false');
    this.trigger.setAttribute('aria-label','Atlas project and checkout');
    this.trigger.onclick=()=>{if(this.panel.hidden)void this.open();else this.close();};
    this.panel.hidden=true;
    this.panel.setAttribute('role','group');this.panel.setAttribute('aria-label','Atlas context');
    const projectField=element<HTMLDivElement>('div','context-field');
    const projectLabel=element<HTMLLabelElement>('label','','Project');projectLabel.append(this.project);
    projectField.append(projectLabel);
    const checkoutLabel=element<HTMLLabelElement>('label','','Checkout');checkoutLabel.append(this.checkout);
    this.checkoutField.append(checkoutLabel);
    const actions=element<HTMLDivElement>('div','context-actions');
    const cancel=element<HTMLButtonElement>('button','context-cancel','Cancel');cancel.type='button';cancel.onclick=()=>this.close();
    this.save.type='button';this.save.onclick=()=>{void this.commit();};
    actions.append(cancel,this.save);
    this.status.setAttribute('role','status');
    this.panel.append(projectField,this.checkoutField,this.status,actions);
    root.append(this.trigger,this.panel);
    this.project.onchange=()=>{void this.loadCheckouts(null);};
    this.checkout.onchange=()=>this.updateSave();
    this.setSession(null);
  }
  setSession(session:ContextSession|null){
    const changed=this.session?.id!==session?.id;
    this.session=session;
    const ctx=session?.atlasContext;
    this.trigger.textContent=ctx?(ctx.checkoutName?ctx.projectName+' / '+ctx.checkoutName:ctx.projectName):'No project';
    if(changed)this.close();
    this.updateSave();
  }
  private close(){
    this.generation++;this.loading=false;this.panel.hidden=true;
    this.trigger.setAttribute('aria-expanded','false');
  }
  private updateSave(){
    const projectId=this.project.value;
    const selectedProject=this.projects.some(p=>p.id===projectId);
    const selectedCheckout=this.checkout.value;
    const valid=!projectId||(selectedProject&&(!selectedCheckout||this.checkouts.some(c=>c.checkoutId===selectedCheckout)));
    this.save.disabled=!this.session||this.session.busy||this.loading||!valid;
    if(this.session?.busy)this.status.textContent='Finish the active task before changing context.';
  }
  private async open(){
    if(!this.session)return;
    this.panel.hidden=false;this.trigger.setAttribute('aria-expanded','true');
    const generation=++this.generation;
    this.loading=true;this.status.textContent='Loading projects…';
    this.project.disabled=true;this.checkout.disabled=true;this.updateSave();
    const selected=this.session.atlasContext;
    try {
      const response=await this.api('/atlas/context/projects');
      const data=await response.json() as {projects:AtlasProject[]};
      if(generation!==this.generation)return;
      this.projects=data.projects;
      this.project.replaceChildren();option(this.project,'','No project');
      for(const p of this.projects)option(this.project,p.id,p.name);
      if(selected?.projectId&&!this.projects.some(p=>p.id===selected.projectId))
        option(this.project,selected.projectId,selected.projectName+' (unavailable)',true);
      this.project.value=selected?.projectId??'';
      this.project.disabled=false;
      this.status.textContent=this.projects.length?'':'No Atlas projects found.';
      await this.loadCheckouts(selected?.checkoutId??null);
    }catch{
      if(generation!==this.generation)return;
      this.projects=[];this.checkouts=[];
      this.project.replaceChildren();option(this.project,'','No project');
      if(selected)option(this.project,selected.projectId,selected.projectName+' (unavailable)',true);
      this.project.value=selected?.projectId??'';
      this.project.disabled=false;
      this.checkout.replaceChildren();this.checkoutField.hidden=true;
      this.status.textContent='Atlas unavailable. Your saved selection has not changed.';
      this.loading=false;this.updateSave();
    }
  }
  private async loadCheckouts(savedCheckout:string|null){
    const generation=++this.generation,sessionId=this.session?.id;
    const projectId=this.project.value;
    this.checkouts=[];this.checkout.replaceChildren();
    option(this.checkout,'','No checkout');
    this.checkoutField.hidden=!projectId;
    this.loading=!!projectId;this.checkout.disabled=true;this.updateSave();
    if(!projectId){this.status.textContent=this.projects.length?'':'No Atlas projects found.';this.loading=false;this.updateSave();return;}
    if(!this.projects.some(p=>p.id===projectId)){
      this.status.textContent='Selected project is unavailable.';
      this.loading=false;this.updateSave();return;
    }
    this.status.textContent='Loading checkouts…';
    try{
      const response=await this.api('/atlas/context/projects/'+encodeURIComponent(projectId)+'/checkouts');
      const data=await response.json() as {checkouts:AtlasCheckout[]};
      if(generation!==this.generation||sessionId!==this.session?.id)return;
      this.checkouts=data.checkouts;
      for(const checkout of data.checkouts)
        option(this.checkout,checkout.checkoutId,checkout.name+(checkout.logicalWorkspaceId?' · Workspace '+checkout.logicalWorkspaceId.slice(0,8):''));
      if(savedCheckout&&!data.checkouts.some(c=>c.checkoutId===savedCheckout))
        option(this.checkout,savedCheckout,'Previous checkout (unavailable)',true);
      this.checkout.value=savedCheckout??'';
      this.checkout.disabled=false;
      this.status.textContent=data.checkouts.length?'':'No checkouts in this project.';
    }catch{
      if(generation!==this.generation||sessionId!==this.session?.id)return;
      if(savedCheckout)option(this.checkout,savedCheckout,'Previous checkout (unavailable)',true);
      this.checkout.value=savedCheckout??'';
      this.status.textContent='Atlas checkouts unavailable. Selection unchanged.';
    }finally{
      if(generation===this.generation){this.loading=false;this.updateSave();}
    }
  }
  private async commit(){
    if(!this.session||this.save.disabled)return;
    const sessionId=this.session.id,projectId=this.project.value||null,checkoutId=projectId?(this.checkout.value||null):null;
    this.loading=true;this.updateSave();this.status.textContent='Saving…';
    try{
      const response=await this.api('/sessions/'+sessionId+'/context',{method:'PATCH',body:JSON.stringify({projectId,checkoutId})});
      const data=await response.json() as {session:ContextSession};
      if(this.session?.id!==sessionId)return;
      this.setSession(data.session);this.close();
    }catch(e){
      if(this.session?.id===sessionId){this.status.textContent=e instanceof Error?e.message:'Could not save context';this.notify(e);}
    }finally{this.loading=false;this.updateSave();}
  }
}
