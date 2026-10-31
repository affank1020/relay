import type { Task, ExecutionEvent, Approval } from './store.js';
import { renderMarkdown } from './markdown.js';
import { AtlasContextPicker } from './atlas-picker.js';
import type { AtlasContext } from './atlas-context.js';
interface Summary { id:string; title:string; modelKey?:string; atlasContext?:AtlasContext|null; busy:boolean; costUsd:number; usage:{costKind:string;tokens:number;unknown:boolean}; }
interface Snapshot { session:Summary; tasks:Task[]; approvals:Approval[]; }
function $<T extends HTMLElement=HTMLElement>(id:string):T { const n=document.getElementById(id);if(!n)throw new Error('Missing element '+id);return n as T; }
const hosted=window.location.protocol==='https:';
let token='',current:string|null=null,busy=false,polling=false,timer:ReturnType<typeof setTimeout>|undefined,cursor=0,epoch=0,lastView='',submitting=false;
let pending:{conversationId:string;message:string;requestId:string}|null=null;
const activity:ExecutionEvent[]=[];
// Separate durable-in-session receipt index from the capped activity inspector.
// One latest event per tool invocation is retained for each task, including old
// turns and paginated history replayed when a conversation is reopened.
const toolReceipts=new Map<string,Map<string,ExecutionEvent>>();
let receiptVersion=0;
function indexToolReceipt(event:ExecutionEvent){
  if(event.type!=='tool'||!event.invocationId||!event.taskId)return;
  let task=toolReceipts.get(event.taskId);
  if(!task){task=new Map();toolReceipts.set(event.taskId,task);}
  if(task.get(event.invocationId)?.id===event.id)return;
  task.set(event.invocationId,event);
  receiptVersion++;
}
let configuredModels:{key:string;label:string}[]=[];
let knownSessions:Summary[]=[];
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
const atlasPicker=new AtlasContextPicker($('atlasContext'),api,notify);
function setBusy(value:boolean){
  busy=value;
  $<HTMLButtonElement>('send').disabled=value||submitting;
  $<HTMLTextAreaElement>('prompt').disabled=value;
  $('stop').hidden=!value;
  $('state').hidden=!value;
  $('state').textContent='Working…';
  $('state').className='run-state'+(value?' is-running':'');
}
function toolLabel(tool:string|null){
  return (tool||'Atlas action').replace(/^atlas_/,'').replace(/^workspace_/,'Workspace · ').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}
function currentToolEvents(taskId:string){
  return [...(toolReceipts.get(taskId)?.values()??[])].sort((a,b)=>a.sequence-b.sequence);
}
function renderSessions(){
  const q=$<HTMLInputElement>('sessionSearch').value.trim().toLowerCase();
  const matched=knownSessions.filter(s=>s.title.toLowerCase().includes(q));
  $('sessionCount').textContent=String(matched.length);
  const parent=$('sessions');parent.replaceChildren();
  for(const session of matched){
    const button=el('button','session'+(session.id===current?' selected':''),'') as HTMLButtonElement;
    button.type='button';button.title=session.title;
    const title=el('span','session-title',session.title);
    button.append(title);
    if(session.busy)button.append(el('span','session-running',''));
    button.onclick=()=>{void select(session.id).catch(notify);closeSidebar();};
    parent.append(button);
  }
  if(!matched.length)parent.append(el('p','sidebar-empty',q?'No matching conversations.':'No conversations yet.'));
}
function closeSidebar(){document.body?.classList?.remove('sidebar-open');}
function fillPrompt(value:string){
  const prompt=$<HTMLTextAreaElement>('prompt');
  prompt.value=value;prompt.focus();
}
function emptyConversation(){
  const wrapper=el('div','empty','');
  wrapper.append(el('h2','','What are we working on?'));
  const chips=el('div','prompt-chips','');
  for(const [label,message] of [
    ['Atlas status','Use Atlas MCP to get the current Atlas status.'],
    ['Projects','Use Atlas MCP to list my projects.'],
    ['Workspaces','Use Atlas MCP to list my workspaces and their associated Nodes.'],
    ['Nodes','Use Atlas MCP to list my Nodes and their available capabilities.']
  ]){
    const button=el('button','prompt-chip','') as HTMLButtonElement;
    button.type='button';
    button.append(el('span','',label),el('span','','↗'));
    button.onclick=()=>fillPrompt(message);
    chips.append(button);
  }
  wrapper.append(chips);return wrapper;
}

async function refresh(){
  const [state,list]=await Promise.all([get<{provider:string;model:string;atlas:string;ollamaOnline?:boolean;defaultModelKey?:string;models?:{key:string;label:string}[]}>('/status'),get<{sessions:Summary[]}>('/sessions')]);
  configuredModels=state.models??[];
  if(configuredModels.length){
    const picker=$<HTMLSelectElement>('modelPicker'),previous=picker.value;
    picker.replaceChildren();
    for(const option of configuredModels){
      const item=document.createElement('option');
      item.value=option.key;
      const offline=option.key.startsWith('ollama/')&&state.ollamaOnline===false;
      item.textContent=option.label+(offline?' (offline)':'');
      item.disabled=offline;
      picker.append(item);
    }
    const pinned=list.sessions.find(c=>c.id===current)?.modelKey;
    if(pinned?.startsWith('ollama/')&&!configuredModels.some(x=>x.key===pinned)){
      const missing=document.createElement('option');missing.value=pinned;
      missing.textContent='MacBook · '+pinned.slice(7)+' (not installed)';
      missing.disabled=true;picker.append(missing);
    }
    picker.value=configuredModels.some(x=>x.key===previous)?previous:(pinned&&[...picker.options].some(x=>x.value===pinned)?pinned:(state.defaultModelKey??configuredModels[0].key));
  }
  $('connection').textContent=state.provider==='Preview'?'Local preview':'Pi connected';
  const atlas=$('atlasSummary');
  atlas.title=state.atlas==='configured'?'Atlas MCP configured, not independently health checked':'Atlas is not connected';
  $('atlasLabel').textContent=state.atlas==='configured'?'Atlas MCP':state.atlas==='mock'?'Atlas (sample)':'Atlas not configured';
  $('atlasOrb').className='status-orb'+(state.atlas==='configured'?'':' is-muted');
  knownSessions=list.sessions;
  renderSessions();
  return list.sessions;
}
function render(data:Snapshot){
  // Enqueue retitles the first message server-side. Keep the searchable
  // sidebar in sync with the authoritative snapshot, not only /sessions.
  const known=knownSessions.find(s=>s.id===data.session.id);
  if(known && (known.title!==data.session.title || known.busy!==data.session.busy)){
    known.title=data.session.title;
    known.busy=data.session.busy;
    renderSessions();
  }
  const serialized=JSON.stringify(data.tasks)+'|'+receiptVersion;
  if(serialized!==lastView){
    const messages=$('messages');const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<120;
    messages.replaceChildren();
    if(!data.tasks.length)messages.append(emptyConversation());
    for(const task of data.tasks){
      const user=el('div','message user',task.prompt);messages.append(user);
      const assistant=el('div','message assistant','');
      const events=currentToolEvents(task.id);
      if(events.length){
        const tools=el('div','inline-tools','');
        for(const event of events){
          const pill=el('div','tool-pill '+event.state,'');
          pill.append(el('strong','',toolLabel(event.tool)),el('span','tool-state',event.state));
          tools.append(pill);
        }
        assistant.append(tools);
      }
      if(task.result)assistant.append(renderMarkdown(task.result));
      else if(task.error)assistant.append(el('p','error',task.error));
      else assistant.append(el('p','status-line',task.state==='queued'?'Waiting for available agent…':'Working on your request…'));

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
  atlasPicker.setSession(data.session);
  const picker=$<HTMLSelectElement>('modelPicker');
  if(data.session.modelKey&&!configuredModels.some(m=>m.key===data.session.modelKey)&&![...picker.options].some(x=>x.value===data.session.modelKey)){
    const missing=document.createElement('option');missing.value=data.session.modelKey;
    missing.textContent=(data.session.modelKey.startsWith('ollama/')?'MacBook · '+data.session.modelKey.slice(7):data.session.modelKey)+' (not installed)';
    missing.disabled=true;picker.append(missing);
  }
  if(data.session.modelKey)picker.value=data.session.modelKey;
  $('cost').textContent=data.session.usage.tokens+' tokens'+(data.session.usage.unknown?' · usage incomplete':data.session.modelKey?.startsWith('ollama/')?' · local':' · $'+data.session.costUsd.toFixed(4));
  setBusy(data.session.busy);
  $('approvals').replaceChildren();
  for(const a of data.approvals.filter(a=>a.state==='pending')){
    const card=el('div','approval','');card.append(el('strong','','Approval required · '+toolLabel(a.tool)));
    card.append(el('pre','',JSON.stringify(a.args,null,2)));
    for(const approved of [true,false]){
      const button=el('button','action'+(approved?'':' deny'),approved?'Approve action':'Reject') as HTMLButtonElement;
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
      const summary=el('summary','','');
      summary.append(el('span','event-marker '+e.state,''));
      const item=el('span','event-summary','');
      item.append(el('span','event-title',e.type==='tool'?toolLabel(e.tool):e.type==='task'?'Agent task':e.type==='approval'?'Approval required':e.type==='usage'?'Model usage':e.type));
      item.append(el('span','event-sub',new Date(e.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})));
      summary.append(item,el('span','event-open','⌄'));
      details.append(summary);
      const fields={state:e.state,timestamp:e.timestamp,task:e.taskId,agentRun:e.agentRunId,invocation:e.invocationId,atlasOperation:e.atlasOperationId,project:e.projectId,workspace:e.workspaceId,selectedNode:e.selectedNodeId,executingNode:e.executingNodeId??'Not confirmed'};
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
    for(const event of replay.events){
      if(event.sequence<=cursor||event.type==='delta')continue;
      indexToolReceipt(event);
      activity.push(event);
    }
    cursor=replay.nextCursor;
    if(activity.length>300)activity.splice(0,activity.length-300);
    renderActivity();
    render(snapshot);
    $('notice').textContent=pending?'A send is awaiting confirmation. Retry uses the same request ID.':'';
  }catch(e){notify('Connection interrupted. Reconnecting safely; no prompt is resubmitted. '+text(e));}
  finally{polling=false;if(timer)clearTimeout(timer);timer=setTimeout(()=>{void poll();},600);}
}
async function select(id:string){
  epoch++;current=id;cursor=0;lastView='';activity.length=0;toolReceipts.clear();receiptVersion=0;$('activity').replaceChildren();remember('relay.conversation',id);
  const generation=epoch;const data=await get<Snapshot>('/sessions/'+id);
  if(generation!==epoch)return;
  render(data);await refresh();void poll();
}
async function create(){const picker=$<HTMLSelectElement>('modelPicker');if(picker.selectedOptions[0]?.disabled)throw new Error('Local model offline. Start Ollama or choose another model.');const modelKey=picker.value;const result=await (await api('/sessions',{method:'POST',body:JSON.stringify(modelKey?{modelKey}:{})})).json() as {session:Summary};await select(result.session.id);$<HTMLTextAreaElement>('prompt').focus();}
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
$('new').onclick=()=>{void create().then(closeSidebar).catch(notify);};
$<HTMLInputElement>('sessionSearch').oninput=renderSessions;
$('openSidebar').onclick=()=>{document.body?.classList?.add('sidebar-open');};
// Explicit shortcut, matching the keycap in the sidebar. Do not intercept regular typing.
document.addEventListener?.('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();void create().catch(notify);}});
$('closeSidebar').onclick=closeSidebar;
$('closeInspector').onclick=()=>{const panel=$('inspector');panel.hidden=true;$('toggleInspector').setAttribute('aria-expanded','false');};
$<HTMLSelectElement>('modelPicker').onchange=()=>{void create().catch(notify);};
$<HTMLFormElement>('form').onsubmit=event=>{void submit(event);};
$('stop').onclick=()=>{if(current)void api('/sessions/'+current+'/abort',{method:'POST',body:'{}'}).then(()=>poll()).catch(notify);};
$<HTMLTextAreaElement>('prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$<HTMLFormElement>('form').requestSubmit();}};
$('toggleInspector').onclick=()=>{const panel=$('inspector');panel.hidden=!panel.hidden;$('toggleInspector').setAttribute('aria-expanded',String(!panel.hidden));};
// Refresh optional Ollama availability without changing conversations.
window.setInterval?.(()=>{if(document.visibilityState!=='hidden')void refresh().catch(()=>{});},60_000);
void bootstrap();
