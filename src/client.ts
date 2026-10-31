import type { Task, ExecutionEvent, Approval } from './store.js';
interface Summary { id:string; title:string; modelKey?:string; busy:boolean; costUsd:number; usage:{costKind:string;tokens:number;unknown:boolean}; }
interface Snapshot { session:Summary; tasks:Task[]; approvals:Approval[]; }
function $<T extends HTMLElement=HTMLElement>(id:string):T { const n=document.getElementById(id);if(!n)throw new Error('Missing element '+id);return n as T; }
const hosted=window.location.protocol==='https:';
let token='',current:string|null=null,busy=false,polling=false,timer:ReturnType<typeof setTimeout>|undefined,cursor=0,epoch=0,lastView='',submitting=false;
let pending:{conversationId:string;message:string;requestId:string}|null=null;
const activity:ExecutionEvent[]=[];
let configuredModels:{key:string;label:string}[]=[];
const text=(e:unknown)=>e instanceof Error?e.message:String(e);
function el(tag:string,className:string,value:string){const n=document.createElement(tag);n.className=className;n.textContent=value;return n;}
function remember(key:string,value:string){try{window.sessionStorage?.setItem(key,value);}catch{}}
function recall(key:string){try{return window.sessionStorage?.getItem(key)||'';}catch{return '';}}
async function api(path:string,options:RequestInit={}):Promise<Response>{
  const headers=new Headers(options.headers);headers.set('Content-Type','application/json');
  if(!hosted&&token)headers.set('Authorization','Bearer '+token);
  if(hosted)headers.delete('Authorization');
  const response=await fetch('/api'+path,{...options,headers,credentials:'same-origin'});
  if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:string};throw new Error(data.error||'Request failed');}
  return response;
}
async function get<T>(path:string){return await (await api(path)).json() as T;}
function notify(error:unknown){$('notice').textContent=text(error);}
function setBusy(value:boolean){busy=value;$<HTMLButtonElement>('send').disabled=value||submitting;$<HTMLTextAreaElement>('prompt').disabled=value;$('stop').hidden=!value;$('state').textContent=value?'Working…':'Idle';}
async function refresh(){
  const [state,list]=await Promise.all([get<{provider:string;model:string;atlas:string;defaultModelKey?:string;models?:{key:string;label:string}[]}>('/status'),get<{sessions:Summary[]}>('/sessions')]);
  configuredModels=state.models??[];
  if(configuredModels.length){
    const picker=$<HTMLSelectElement>('modelPicker'),previous=picker.value;
    picker.replaceChildren();
    for(const option of configuredModels){const item=document.createElement('option');item.value=option.key;item.textContent=option.label;picker.append(item);}
    picker.value=configuredModels.some(x=>x.key===previous)?previous:(state.defaultModelKey??configuredModels[0].key);
  }
  $('model').textContent='Pi · '+(configuredModels.find(m=>m.key===$<HTMLSelectElement>('modelPicker').value)?.label??state.model);
  $('connection').textContent='Pi connected';$('subtitle').textContent='Atlas '+state.atlas;
  $('sessions').replaceChildren();
  for(const s of list.sessions){const button=el('button','session'+(s.id===current?' selected':''),s.title) as HTMLButtonElement;button.type='button';button.onclick=()=>{void select(s.id).catch(notify);};$('sessions').append(button);}
  return list.sessions;
}
function render(data:Snapshot){
  const serialized=JSON.stringify(data.tasks);
  if(serialized!==lastView){
    const messages=$('messages');const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<120;
    messages.replaceChildren();
    if(!data.tasks.length)messages.append(el('div','empty','Ask Relay a question or give it work to coordinate.'));
    for(const task of data.tasks){
      const user=el('div','message user',task.prompt);messages.append(user);
      const assistant=el('div','message assistant','');assistant.append(el('span','heading','Relay · '+task.state),el('div','text',task.result||task.error||(task.state==='queued'?'Queued…':'Working…')));
      if(task.error&&task.result)assistant.append(el('p','error',task.error));
      if(['failed','interrupted','cancelled'].includes(task.state)){
        const retry=el('button','action','Retry in new conversation') as HTMLButtonElement;
        retry.onclick=async()=>{if(!window.confirm('Confirm you have checked Atlas for any completed or uncertain tool effects. A retry may repeat work.'))return;try{const r=await (await api('/tasks/'+task.id+'/retry',{method:'POST',body:'{"reconciled":true}'})).json() as {task:Task};await select(r.task.conversationId);}catch(e){notify(e);}};
        assistant.append(retry);
      }
      messages.append(assistant);
    }
    if(nearBottom||!lastView)messages.scrollTop=messages.scrollHeight;
    lastView=serialized;
  }
  $('title').textContent=data.session.title;
  const picker=$<HTMLSelectElement>('modelPicker');
  if(data.session.modelKey&&configuredModels.some(m=>m.key===data.session.modelKey))picker.value=data.session.modelKey;
  $('model').textContent='Pi · '+(configuredModels.find(m=>m.key===picker.value)?.label??'OpenRouter');
  $('cost').textContent=(data.session.usage.unknown?'Usage incomplete · ':'')+data.session.usage.costKind+' $'+data.session.costUsd.toFixed(4)+' · '+data.session.usage.tokens+' tokens';
  setBusy(data.session.busy);
  $('approvals').replaceChildren();
  for(const a of data.approvals.filter(a=>a.state==='pending')){
    const card=el('div','approval','Approval required: '+a.tool);
    card.append(el('pre','',JSON.stringify(a.args,null,2)));
    for(const approved of [true,false]){
      const button=el('button','action',approved?'Approve operation':'Reject operation') as HTMLButtonElement;
      button.onclick=async()=>{button.disabled=true;try{await api('/approvals/'+a.id,{method:'POST',body:JSON.stringify({approved})});await poll();}catch(e){notify(e);}};
      card.append(button);
    }
    $('approvals').append(card);
  }
}
function renderActivity(){
  // Polling must not replace existing <details> nodes: that closes expanded
  // entries and drops keyboard focus every 600ms.
  const parent=$('activity');
  const events=activity.slice(-100).reverse();
  const existing=new Map(Array.from(parent.children).map(child=>[(child as HTMLElement).dataset.eventId,child as HTMLElement]));
  for(const [index,e] of events.entries()){
    let details=existing.get(e.id);
    if(!details){
      details=el('details','activity','');
      details.dataset.eventId=e.id;
      details.append(el('summary','',(e.tool||e.type)+' · '+e.state));
      const fields={timestamp:e.timestamp,task:e.taskId,agentRun:e.agentRunId,invocation:e.invocationId,atlasOperation:e.atlasOperationId,project:e.projectId,checkout:e.workspaceId,selectedNode:e.selectedNodeId,executingNode:e.executingNodeId??'Unknown'};
      details.append(el('pre','',JSON.stringify(fields,null,2)));
    }
    if(parent.children[index]!==details)parent.insertBefore(details,parent.children[index]??null);
  }
  while(parent.children.length>events.length)parent.lastElementChild?.remove();
}
async function poll(){
  if(!current||polling)return;
  const id=current,generation=epoch;polling=true;
  try{
    const [snapshot,replay]=await Promise.all([get<Snapshot>('/sessions/'+id),get<{events:ExecutionEvent[];nextCursor:number;hasMore:boolean}>('/sessions/'+id+'/events?after='+cursor)]);
    if(generation!==epoch)return;
    render(snapshot);
    for(const event of replay.events)if(event.sequence>cursor&&event.type!=='delta')activity.push(event);
    cursor=replay.nextCursor;
    if(activity.length>300)activity.splice(0,activity.length-300);
    renderActivity();
    $('notice').textContent=pending?'A send is awaiting confirmation. Retry uses the same request ID.':'';
  }catch(e){notify('Connection interrupted. Reconnecting safely; no prompt is resubmitted. '+text(e));}
  finally{polling=false;if(timer)clearTimeout(timer);timer=setTimeout(()=>{void poll();},600);}
}
async function select(id:string){
  epoch++;current=id;cursor=0;lastView='';activity.length=0;$('activity').replaceChildren();remember('relay.conversation',id);
  const generation=epoch;const data=await get<Snapshot>('/sessions/'+id);
  if(generation!==epoch)return;
  render(data);await refresh();void poll();
}
async function create(){const modelKey=$<HTMLSelectElement>('modelPicker').value;const result=await (await api('/sessions',{method:'POST',body:JSON.stringify(modelKey?{modelKey}:{})})).json() as {session:Summary};await select(result.session.id);$<HTMLTextAreaElement>('prompt').focus();}
async function submit(event:Event){
  event.preventDefault();if(busy||submitting)return;
  const prompt=$<HTMLTextAreaElement>('prompt');const value=prompt.value.trim();if(!value&&!pending)return;
  submitting=true;setBusy(busy);
  try{
    if(!current)await create();
    if(!pending)pending={conversationId:current!,message:value,requestId:crypto.randomUUID()};
    remember('relay.pending',JSON.stringify(pending));
    const {conversationId,message,requestId}=pending;
    await api('/sessions/'+conversationId+'/messages',{method:'POST',body:JSON.stringify({message,requestId})});
    pending=null;remember('relay.pending','');prompt.value='';
    if(current!==conversationId)await select(conversationId);else await poll();
  }catch(e){notify('Send not confirmed. Press Send to retry the same request safely. '+text(e));}
  finally{submitting=false;setBusy(busy);}
}
function hostedError(error:unknown,stage:'api'|'session'){
  $('connection').textContent=stage==='session'?'Session unavailable':'API unavailable';
  $('settings').hidden=false;$('settings').title='Retry connection';
  $('messages').replaceChildren(el('div','empty','Relay '+stage+' request failed: '+text(error)+'. Retry the connection.'));
}
async function bootstrap(){
  let stage:'api'|'session'='api';
  try{
    await api('/status');$('settings').hidden=hosted;
    const sessions=await refresh();stage='session';
    const remembered=recall('relay.conversation');
    try{const saved=JSON.parse(recall('relay.pending')||'null');if(saved&&typeof saved.message==='string'&&typeof saved.requestId==='string'&&typeof saved.conversationId==='string')pending=saved;}catch{}
    if(!current){const selected=sessions.find(s=>s.id===remembered)||sessions[0];if(selected)await select(selected.id);else await create();}
  }catch(e){if(hosted)hostedError(e,stage);else $<HTMLDialogElement>('login').showModal();}
}
$<HTMLFormElement>('loginForm').onsubmit=async event=>{
  event.preventDefault();if(hosted)return;
  token=$<HTMLInputElement>('token').value;
  try{await api('/status');$<HTMLDialogElement>('login').close();$<HTMLInputElement>('token').value='';$('error').textContent='';await bootstrap();}
  catch(e){$('error').textContent=text(e);}
};
$('settings').onclick=()=>{if(hosted){void bootstrap();return;}token='';$<HTMLDialogElement>('login').showModal();};
$('new').onclick=()=>{void create().catch(notify);};
$<HTMLSelectElement>('modelPicker').onchange=()=>{void create().catch(notify);};
$<HTMLFormElement>('form').onsubmit=event=>{void submit(event);};
$('stop').onclick=()=>{if(current)void api('/sessions/'+current+'/abort',{method:'POST',body:'{}'}).then(()=>poll()).catch(notify);};
$<HTMLTextAreaElement>('prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$<HTMLFormElement>('form').requestSubmit();}};
$('toggleInspector').onclick=()=>{const panel=$('inspector');panel.hidden=!panel.hidden;$('toggleInspector').setAttribute('aria-expanded',String(!panel.hidden));};
$('showTasks').onclick=async()=>{
  try{const data=await get<{tasks:Task[]}>('/tasks');$('taskList').replaceChildren();for(const t of data.tasks){const button=el('button','session',t.state+' · '+t.prompt.slice(0,70)) as HTMLButtonElement;button.onclick=()=>{void select(t.conversationId).catch(notify);};$('taskList').append(button);}}
  catch(e){notify(e);}
};
void bootstrap();
