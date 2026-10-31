import type { Task, ExecutionEvent, Approval } from './store.js';
import { renderMarkdown } from './markdown.js';
import { mountTaskConsole } from './task-console.js';
import { AtlasContextPicker } from './atlas-picker.js';
import type { AtlasContext } from './atlas-context.js';
import { projectAtlasCheckouts } from './atlas-awareness.js';
import { renderAtlasCheckoutViews } from './atlas-awareness-ui.js';
import { projectAtlasDetails } from './atlas-awareness-details.js';
import { renderAtlasDetailViews } from './atlas-awareness-details-ui.js';
import { readLiveChatEvents } from './live-chat.js';
interface Summary { id:string; title:string; modelKey?:string; atlasContext?:AtlasContext|null; busy:boolean; costUsd:number; usage:{costKind:string;tokens:number;unknown:boolean}; }
interface Snapshot { session:Summary; tasks:Task[]; approvals:Approval[]; }
function $<T extends HTMLElement=HTMLElement>(id:string):T { const n=document.getElementById(id);if(!n)throw new Error('Missing element '+id);return n as T; }
const hosted=window.location.protocol==='https:';
let token='',current:string|null=null,busy=false,polling=false,timer:ReturnType<typeof setTimeout>|undefined,cursor=0,epoch=0,lastView='',submitting=false;
let pending:{conversationId:string;message:string;requestId:string}|null=null;
// A live stream owns the cursor during an active connection; snapshots are
// authoritative for lifecycle/usage, not for every generated text fragment.
let liveController:AbortController|null=null,liveConnected=false,streamRetries=0;
let reconnectTimer:ReturnType<typeof setTimeout>|undefined;
let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
const canStream=typeof AbortController!=='undefined'&&typeof TextDecoder!=='undefined';
function disconnectStream(){
  liveController?.abort();liveController=null;liveConnected=false;
  if(reconnectTimer)clearTimeout(reconnectTimer);
  if(snapshotTimer)clearTimeout(snapshotTimer);
  reconnectTimer=undefined;snapshotTimer=undefined;streamRetries=0;
}

const activity:ExecutionEvent[]=[];
// Separate durable-in-session receipt index from the capped activity inspector.
// One latest event per tool invocation is retained for each task, including old
// turns and paginated history replayed when a conversation is reopened.
const toolReceipts=new Map<string,Map<string,ExecutionEvent>>();
// Both live and replayed evidence share one bounded session-scoped index.
const atlasObservations=new Map<string,ExecutionEvent>();
let receiptVersion=0;
// Keep a stable DOM node for each turn. Stream updates must not remount the
// conversation, which would lose selection, focus and expanded tool details.
interface MessageRow {
  assistant:HTMLElement; tools:HTMLElement; delegations:HTMLElement; awareness:HTMLElement; awarenessKey:string; content:HTMLElement|null;
  status:HTMLElement; error:HTMLElement; retry:HTMLButtonElement;
  result:string; terminal:boolean; receiptKey:string; delegationKey:string;
}
const messageRows=new Map<string,MessageRow>();
const taskPhases=new Map<string,string>();
const delegatedStates=new Map<string,Map<string,string>>();
function indexDelegation(event:ExecutionEvent) {
  if(event.type!=='delegation'||!event.taskId||!event.childTaskId)return;
  let children=delegatedStates.get(event.taskId);
  if(!children){children=new Map();delegatedStates.set(event.taskId,children);}
  children.set(event.childTaskId,event.state);
}
function indexAtlasObservation(event:ExecutionEvent){
  if(event.type!=='atlas_resource'&&!(event.type==='tool'&&event.workspaceId&&
    ['failed','denied','cancelled'].includes(event.state)))return;
  if(atlasObservations.has(event.id))return;
  atlasObservations.set(event.id,event);
  if(atlasObservations.size>3000)atlasObservations.delete(atlasObservations.keys().next().value!);
}
function resetConversationView(){
  messageRows.clear();taskPhases.clear();delegatedStates.clear();lastView='';
}
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
let sendRecoveryNotice='';
function clearPendingForDeletedConversation(id:string){
  if(pending?.conversationId!==id)return;
  const unsent=pending.message;
  pending=null;
  remember('relay.pending','');
  const prompt=$<HTMLTextAreaElement>('prompt');
  if(!prompt.value.trim()||prompt.value.trim()===unsent.trim()){
    prompt.value=unsent;
    sendRecoveryNotice='That conversation was deleted. Your unconfirmed message is in the composer; review it before sending.';
  }else{
    sendRecoveryNotice='That conversation was deleted. An unconfirmed send was cleared; your current draft is unchanged.';
  }
  $('notice').textContent=sendRecoveryNotice;
}
let menuTarget:string|null=null, menuAnchor:HTMLButtonElement|null=null, dialogTarget:string|null=null;
function closeSessionMenu(restoreFocus=false){
  const menu=$('sessionMenu'),anchor=menuAnchor;
  menu.hidden=true;
  if(anchor)anchor.setAttribute('aria-expanded','false');
  menuTarget=null;menuAnchor=null;
  // Escape is a keyboard dismissal: return to the still-mounted invoker.
  // Pointer dismissal and modal transitions must not steal the new focus.
  if(restoreFocus&&anchor?.isConnected)anchor.focus();
}
function openSessionMenu(id:string,anchor:HTMLButtonElement){
  const menu=$('sessionMenu');
  if(menuTarget===id&&!menu.hidden){closeSessionMenu();return;}
  closeSessionMenu();
  menuTarget=id;menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  const rect=anchor.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(window.innerWidth-166,rect.right-158))+'px';
  menu.style.top=Math.max(8,Math.min(window.innerHeight-86,rect.bottom+3))+'px';
  menu.hidden=false;
  $<HTMLButtonElement>('menuRename').focus();
}
function resetSelection(){
  disconnectStream();
  epoch++;current=null;cursor=0;resetConversationView();activity.length=0;toolReceipts.clear();atlasObservations.clear();receiptVersion=0;
  if(timer)clearTimeout(timer);timer=undefined;
  $('activity').replaceChildren();$('approvals').replaceChildren();$('messages').replaceChildren(emptyConversation());
  $('title').textContent='New chat';$('cost').textContent='0 tokens';
  setBusy(false);remember('relay.conversation','');
  renderSessions();
}
function openRename(id:string){
  const session=knownSessions.find(s=>s.id===id);if(!session)return;
  closeSessionMenu();dialogTarget=id;
  $<HTMLInputElement>('renameInput').value=session.title;
  $('renameError').textContent='';
  const dialog=$<HTMLDialogElement>('renameDialog');dialog.showModal();
  $<HTMLInputElement>('renameInput').focus();$<HTMLInputElement>('renameInput').select();
}
function openDelete(id:string){
  const session=knownSessions.find(s=>s.id===id);if(!session)return;
  closeSessionMenu();dialogTarget=id;
  $('deleteName').textContent=session.title;
  $('deleteError').textContent='';
  $('deleteReadReconcileRow').hidden=true;
  $<HTMLInputElement>('deleteReadReconcile').checked=false;
  $<HTMLDialogElement>('deleteDialog').showModal();
  $<HTMLButtonElement>('deleteCancel').focus();
}
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
  const menu=$('sessionMenu');
  // A refresh replaces the sidebar buttons. If keyboard focus was in the
  // open actions group, give it back to the new invoker after rendering.
  const focusedMenuTarget=!menu.hidden&&document.activeElement&&menu.contains(document.activeElement)
    ?menuTarget:null;
  closeSessionMenu();
  let focusRestored=false;
  const q=$<HTMLInputElement>('sessionSearch').value.trim().toLowerCase();
  const matched=knownSessions.filter(s=>s.title.toLowerCase().includes(q));
  $('sessionCount').textContent=String(matched.length);
  const parent=$('sessions');parent.replaceChildren();
  for(const session of matched){
    const row=el('div','session-row','');
    const button=el('button','session'+(session.id===current&&!taskConsole.visible?' selected':''),'') as HTMLButtonElement;
    button.type='button';button.title=session.title;
    button.append(el('span','session-title',session.title));
    if(session.busy)button.append(el('span','session-running',''));
    button.onclick=()=>{closeSessionMenu();void select(session.id).catch(notify);closeSidebar();};
    const more=el('button','session-more','⋯') as HTMLButtonElement;
    more.type='button';more.title='Conversation actions';
    more.setAttribute('aria-label','Actions for '+session.title);
    more.setAttribute('aria-controls','sessionMenu');more.setAttribute('aria-expanded','false');
    more.onclick=event=>{event.stopPropagation();openSessionMenu(session.id,more);};
    row.append(button,more);parent.append(row);
    if(session.id===focusedMenuTarget){more.focus();focusRestored=true;}
  }
  if(!matched.length)parent.append(el('p','sidebar-empty',q?'No matching conversations.':'No conversations yet.'));
  if(focusedMenuTarget&&!focusRestored)$<HTMLInputElement>('sessionSearch').focus();
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
  // A stale tab may still have a pending send aimed at a chat deleted
  // elsewhere. The authoritative session listing invalidates that target.
  if(pending&&!list.sessions.some(s=>s.id===pending!.conversationId))
    clearPendingForDeletedConversation(pending.conversationId);
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
  const messages=$('messages');
  const observations=[...atlasObservations.values()];
  const observedViews=projectAtlasCheckouts(observations);
  const observedDetails=projectAtlasDetails(observations);
  const firstPaint=!lastView;
  const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<120;
  if(!data.tasks.length) {
    if(lastView!=='empty'){messages.replaceChildren(emptyConversation());lastView='empty';}
  } else {
    if(messageRows.size===0)messages.replaceChildren();
    for(const task of data.tasks){
      let row=messageRows.get(task.id);
      if(!row){
        messages.append(el('div','message user',task.prompt));
        const assistant=el('div','message assistant','');
        const tools=el('div','inline-tools','');
        tools.hidden=true;
        const awareness=el('div','atlas-awareness','');awareness.hidden=true;
        const delegations=el('details','inline-agents','');delegations.hidden=true;
        delegations.append(el('summary','',''),el('div','inline-agent-children',''));
        const status=el('p','status-line','');
        const error=el('p','error','');error.hidden=true;
        const retry=el('button','action','Retry in new conversation') as HTMLButtonElement;
        retry.hidden=true;
        retry.onclick=async()=>{
          if(!window.confirm('Confirm you have checked Atlas for any completed or uncertain tool effects. A retry may repeat work.'))return;
          try {const r=await (await api('/tasks/'+task.id+'/retry',{method:'POST',body:'{"reconciled":true}'})).json() as {task:Task};await select(r.task.conversationId);}catch(e){notify(e);}
        };
        assistant.append(tools,delegations,awareness,status,error,retry);
        messages.append(assistant);
        row={assistant,tools,delegations,awareness,awarenessKey:'',content:null,status,error,retry,result:'',terminal:false,receiptKey:'',delegationKey:''};
        messageRows.set(task.id,row);
      }
      const events=currentToolEvents(task.id);
      const receiptKey=events.map(event=>event.id+':'+event.state).join('|');
      if(receiptKey!==row.receiptKey){
        row.tools.replaceChildren();
        for(const event of events){
          const pill=el('span','tool-pill '+event.state,'');
          pill.append(el('strong','',toolLabel(event.tool)),el('span','tool-state',event.state.replace(/_/g,' ')));
          row.tools.append(pill);
        }
        row.tools.hidden=events.length===0;
        row.receiptKey=receiptKey;
      }
      const matching=observedViews.filter(view=>view.taskId===task.id);
      const details=observedDetails.filter(view=>view.taskId===task.id);
      const awarenessKey=JSON.stringify(matching)+'|'+JSON.stringify(details)+'|'+matching.map(view=>
        view.gitObservedAt&&Date.now()-Date.parse(view.gitObservedAt)>5*60_000?'stale':'recent').join(',')+
        '|'+details.map(view=>{
          const at=view.detail.kind==='review_pr'?view.detail.currentHead.checkedAt:undefined;
          return !at||!Number.isFinite(Date.parse(at))||Date.now()-Date.parse(at)>5*60_000
            ?'historical':'recent';
        }).join(',');
      if(row.awarenessKey!==awarenessKey){
        renderAtlasCheckoutViews(row.awareness,matching);
        renderAtlasDetailViews(row.awareness,details);
        row.awarenessKey=awarenessKey;
      }
      const children=delegatedStates.get(task.id)??new Map<string,string>();
      const delegationKey=[...children].map(([id,state])=>id+':'+state).join('|');
      if(row.delegationKey!==delegationKey){
        row.delegationKey=delegationKey;
        const statuses=[...children.values()];
        const running=statuses.filter(state=>['running','queued','awaiting_approval','waiting_children'].includes(state)).length;
        row.delegations.querySelector('summary')!.textContent=
          children.size+' subagent'+(children.size===1?'':'s')+(running?' · '+running+' active':' · finished');
        const body=row.delegations.querySelector('.inline-agent-children')!;
        body.replaceChildren(...[...children].map(([id,state])=>el('span','inline-agent',id.slice(0,8)+' · '+state.replace(/_/g,' '))));
      }
      row.delegations.hidden=children.size===0;
      const terminal=['completed','failed','interrupted','cancelled'].includes(task.state);
      // During generation, reuse a single text node instead of reparsing and
      // remounting all Markdown on every poll. Format once at completion.
      // A snapshot may have been fetched just before a live delta arrived.
      // Never roll the in-progress response back to older snapshot text.
      const result=!terminal&&row.result.startsWith(task.result)?row.result:task.result;
      if(result!==row.result || terminal!==row.terminal){
        if(result){
          if(!terminal && row.content?.className==='streaming-text'){
            row.content.textContent=result;
          }else{
            const next=terminal?renderMarkdown(result):el('div','streaming-text',result);
            row.assistant.insertBefore(next,row.status);
            row.content?.remove();
            row.content=next;
          }
        }else {row.content?.remove();row.content=null;}
        row.result=result;row.terminal=terminal;
      }
      const activeTool=[...events].reverse().find(event=>['started','validating','running','awaiting_approval'].includes(event.state));
      const phase=taskPhases.get(task.id);
      const label=task.state==='queued'?'Queued for an agent':
        task.state==='waiting_children'?'Waiting for subagents…':
        task.state==='awaiting_approval'?'Waiting for approval':
        activeTool?'Using '+toolLabel(activeTool.tool)+'…':
        task.result?'Responding…':
        phase==='atlas_tool_discovery'?'Connecting to Atlas…':
        ['opening_session','creating_session','pi_initialization'].includes(phase??'')?'Preparing session…':
        phase==='finalizing_response'?'Finishing response…':'Thinking…';
      row.status.hidden=terminal;
      row.status.textContent=label;
      row.status.className='status-line'+(task.state==='queued'?' is-queued':' is-active');
      row.error.hidden=!task.error;
      row.error.textContent=task.error??'';
      row.retry.hidden=!['failed','interrupted','cancelled'].includes(task.state);
    }
    lastView='active';
  }
  if((nearBottom||firstPaint) && lastView!=='empty')messages.scrollTop=messages.scrollHeight;
  if(!taskConsole.visible)$('title').textContent=data.session.title;
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
      const fields={state:e.state,timestamp:e.timestamp,task:e.taskId,agentRun:e.agentRunId,invocation:e.invocationId,atlasOperation:e.atlasOperationId,project:e.projectId,workspace:e.workspaceId,selectedNode:e.selectedNodeId,executingNode:e.executingNodeId??'Not confirmed',resources:e.atlasResource?.resources,evidence:e.atlasResource?.evidenceSource};
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
    // Replay first, snapshot second. Both are read from the same persisted
    // server state: a snapshot fetched after the replay is guaranteed to
    // include every task transition represented by the consumed events.
    // Concurrent requests could otherwise consume a completion event while
    // rendering a stale running snapshot, leaving a live chat stuck busy.
    const replay=await get<{events:ExecutionEvent[];nextCursor:number;hasMore:boolean}>('/sessions/'+id+'/events?after='+cursor);
    if(generation!==epoch)return;
    const snapshot=await get<Snapshot>('/sessions/'+id);
    if(generation!==epoch)return;
    for(const event of replay.events){
      if(event.sequence<=cursor||event.type==='delta')continue;
      indexToolReceipt(event);
      indexAtlasObservation(event);
      indexDelegation(event);
      if(event.type==='phase'&&event.taskId)taskPhases.set(event.taskId,event.state);
      activity.push(event);
    }
    cursor=Math.max(cursor,replay.nextCursor);
    if(activity.length>300)activity.splice(0,activity.length-300);
    renderActivity();
    render(snapshot);
    $('notice').textContent=pending?'A send is awaiting confirmation. Retry uses the same request ID.':sendRecoveryNotice;
  }catch(e){
    if(generation===epoch && text(e).includes('Conversation not found')){
      clearPendingForDeletedConversation(id);
      try {
        const sessions=await refresh();
        if(current===id){
          const fallback=sessions.find(s=>s.id!==id);
          if(fallback)void select(fallback.id).catch(notify);
          else resetSelection();
        }
      }catch(failure){notify(failure);}
    }else if(generation===epoch)notify('Connection interrupted. Reconnecting safely; no prompt is resubmitted. '+text(e));
  }
  finally{
    polling=false;
    if(timer)clearTimeout(timer);
    if(current&&generation===epoch&&!liveConnected)timer=setTimeout(()=>{void poll();},busy?250:850);
  }
}
function scheduleSnapshot(){
  if(snapshotTimer||!current)return;
  const generation=epoch;
  snapshotTimer=setTimeout(()=>{
    snapshotTimer=undefined;
    if(generation!==epoch)return;
    // Avoid dropping refreshes while a previous snapshot request is in flight.
    if(polling){scheduleSnapshot();return;}
    void poll();
  },60);
}
function applyLiveBatch(events:ExecutionEvent[]){
  let needsSnapshot=false,activityChanged=false;
  const messages=$('messages');
  const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<120;
  for(const event of events){
    if(!Number.isSafeInteger(event.sequence)||event.sequence<=cursor)continue;
    // Reject non-contiguous event sequences only when the transport supplies
    // an explicit gap? Global SQLite sequence IDs are shared by conversations,
    // so gaps are normal and must not be treated as loss.
    cursor=event.sequence;
    if(event.type==='delta'){
      const row=event.taskId?messageRows.get(event.taskId):undefined;
      const delta=event.text,offset=event.textOffset;
      if(row&&!row.terminal&&typeof delta==='string'&&Number.isSafeInteger(offset)&&
         typeof offset==='number'&&offset>=delta.length){
        const start=offset-delta.length;
        if(row.result.length>=offset&&row.result.slice(start,offset)===delta)continue;
        if(row.result.length===start){
          row.result+=delta;
          if(row.content?.className==='streaming-text'){
            const node=row.content.firstChild;
            // Append the actual new token span; rewriting the entire text
            // on each chunk causes needless layout work on long responses.
            if(node?.nodeType===3 && 'appendData' in node)(node as Text).appendData(delta);
            else row.content.textContent=row.result;
          }else{
            const content=el('div','streaming-text',row.result);
            row.assistant.insertBefore(content,row.status);
            row.content?.remove();
            row.content=content;
          }
          row.status.textContent='Responding…';
          continue;
        }
      }
      // An old event lacks an absolute text offset, or a snapshot/result
      // raced with replay. Reconcile with the server rather than duplicate it.
      needsSnapshot=true;
      continue;
    }
    indexToolReceipt(event);
    indexAtlasObservation(event);
    indexDelegation(event);
    if(event.type==='phase'&&event.taskId)taskPhases.set(event.taskId,event.state);
    activity.push(event);activityChanged=true;
    needsSnapshot=true;
  }
  if(activityChanged){
    if(activity.length>300)activity.splice(0,activity.length-300);
    renderActivity();
  }
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
  if(needsSnapshot)scheduleSnapshot();
}
async function connectStream(id:string,generation:number){
  if(generation!==epoch||current!==id||!canStream)return;
  const controller=new AbortController();
  liveController=controller;
  try{
    const response=await api('/sessions/'+id+'/stream?after='+cursor,{signal:controller.signal});
    if(generation!==epoch||controller.signal.aborted)return;
    liveConnected=true;streamRetries=0;
    if(timer)clearTimeout(timer);
    timer=undefined;
    await readLiveChatEvents(response,events=>{
      if(generation===epoch&&!controller.signal.aborted)applyLiveBatch(events);
    });
  }catch{
    // Transport interruptions are expected on laptop sleep or proxy expiry.
    // The durable cursor and ordinary polling recover without prompt replay.
  }finally{
    if(liveController!==controller)return;
    liveController=null;
    liveConnected=false;
    if(generation!==epoch||current!==id||controller.signal.aborted)return;
    // Recover state immediately and continue polling until reconnected.
    void poll();
    const delay=Math.min(1000*2**Math.min(streamRetries++,4),15000);
    reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;void connectStream(id,generation);},delay);
  }
}
async function select(id:string){
  closeTaskConsole();
  disconnectStream();
  epoch++;current=id;cursor=0;resetConversationView();activity.length=0;toolReceipts.clear();atlasObservations.clear();receiptVersion=0;$('activity').replaceChildren();remember('relay.conversation',id);
  const generation=epoch;const data=await get<Snapshot>('/sessions/'+id);
  if(generation!==epoch)return;
  render(data);await refresh();
  // Rehydrate durable receipts first, then subscribe from that cursor.
  // A reconnect fetches all missed events and ignores repeated sequences.
  void poll().then(()=>{if(generation===epoch&&canStream)void connectStream(id,generation);});
}
async function create(){closeTaskConsole();const picker=$<HTMLSelectElement>('modelPicker');if(picker.selectedOptions[0]?.disabled)throw new Error('Local model offline. Start Ollama or choose another model.');const modelKey=picker.value;const result=await (await api('/sessions',{method:'POST',body:JSON.stringify(modelKey?{modelKey}:{})})).json() as {session:Summary};await select(result.session.id);$<HTMLTextAreaElement>('prompt').focus();}
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
    pending=null;remember('relay.pending','');prompt.value='';sendRecoveryNotice='';
    if(current!==conversationId)await select(conversationId);else await poll();
  }catch(e){
    if(text(e)==='Conversation not found'&&pending)
      clearPendingForDeletedConversation(pending.conversationId);
    else notify('Send not confirmed. Press Send to retry the same request safely. '+text(e));
  }
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
    if(pending&&!sessions.some(s=>s.id===pending!.conversationId))
      clearPendingForDeletedConversation(pending.conversationId);
    if(!current){const selected=sessions.find(s=>s.id===remembered)||sessions[0];if(selected)await select(selected.id);else await create();}
  }catch(e){if(hosted)hostedError(e,stage);else $<HTMLDialogElement>('login').showModal();}
}
const taskConsole=mountTaskConsole(api,async id=>{await select(id);closeSidebar();});
function closeTaskConsole(){
  if(!taskConsole.visible)return;
  taskConsole.hide();
  for(const id of ['messages','approvals','notice'])$(id).hidden=false;
  document.querySelector('.composer')?.removeAttribute('hidden');
  $('toggleInspector').hidden=false;
  $('title').textContent=knownSessions.find(s=>s.id===current)?.title??'New chat';
  $('openTaskConsole').setAttribute('aria-pressed','false');
  renderSessions();
}
$('openTaskConsole').onclick=()=>{
  if(taskConsole.visible){closeTaskConsole();return;}
  for(const id of ['messages','approvals','notice'])$(id).hidden=true;
  document.querySelector('.composer')?.setAttribute('hidden','');
  $('inspector').hidden=true;
  $('toggleInspector').hidden=true;
  $('toggleInspector').setAttribute('aria-expanded','false');
  $('title').textContent='Tasks & agents';
  $('openTaskConsole').setAttribute('aria-pressed','true');
  closeSidebar();
  renderSessions();
  void taskConsole.show().catch(notify);
};
$<HTMLFormElement>('loginForm').onsubmit=async event=>{
  event.preventDefault();if(hosted)return;
  token=$<HTMLInputElement>('token').value;
  try{await api('/status');$<HTMLDialogElement>('login').close();$<HTMLInputElement>('token').value='';$('error').textContent='';await bootstrap();}
  catch(e){$('error').textContent=text(e);}
};
$('settings').onclick=()=>{if(hosted){void bootstrap();return;}token='';$<HTMLDialogElement>('login').showModal();};
$('new').onclick=()=>{closeSessionMenu();void create().then(closeSidebar).catch(notify);};
$<HTMLButtonElement>('menuRename').onclick=()=>{if(menuTarget)openRename(menuTarget);};
$<HTMLButtonElement>('menuDelete').onclick=()=>{if(menuTarget)openDelete(menuTarget);};
$<HTMLButtonElement>('renameCancel').onclick=()=>$<HTMLDialogElement>('renameDialog').close();
$<HTMLButtonElement>('deleteCancel').onclick=()=>$<HTMLDialogElement>('deleteDialog').close();
$<HTMLDialogElement>('renameDialog').onclose=()=>{dialogTarget=null;};
$<HTMLDialogElement>('deleteDialog').onclose=()=>{dialogTarget=null;};
$<HTMLFormElement>('renameForm').onsubmit=event=>{
  event.preventDefault();
  const id=dialogTarget;if(!id)return;
  const input=$<HTMLInputElement>('renameInput'),title=input.value.trim();
  if(!title||[...title].length>120||/[\u0000-\u001f\u007f-\u009f]/u.test(title)){
    $('renameError').textContent='Use 1–120 characters without control characters.';return;
  }
  const save=$<HTMLButtonElement>('renameSave');save.disabled=true;
  void (async()=>{
    try{
      await api('/sessions/'+id,{method:'PATCH',body:JSON.stringify({title})});
      $<HTMLDialogElement>('renameDialog').close();
      $('notice').textContent='';
      if(current===id)await select(id);else await refresh();
    }catch(e){$('renameError').textContent=text(e);}
    finally{save.disabled=false;}
  })();
};
$<HTMLFormElement>('deleteForm').onsubmit=event=>{
  event.preventDefault();
  const id=dialogTarget;if(!id)return;
  const confirm=$<HTMLButtonElement>('deleteConfirm');confirm.disabled=true;
  void (async()=>{
    try{
      if($<HTMLInputElement>('deleteReadReconcile').checked){
        await api('/sessions/'+id+'/reconcile-mcp-reads',{method:'POST',body:JSON.stringify({confirmed:true})});
      }
      await api('/sessions/'+id,{method:'DELETE'});
      $<HTMLDialogElement>('deleteDialog').close();
      if(pending?.conversationId===id){pending=null;remember('relay.pending','');}
      const wasCurrent=current===id;
      if(wasCurrent){disconnectStream();epoch++;current=null;if(timer)clearTimeout(timer);}
      const sessions=await refresh();
      $('notice').textContent='';
      if(wasCurrent){
        if(sessions.length)await select(sessions[0].id);
        else resetSelection();
      }
    }catch(e){
      const reason=text(e);
      if(reason==='Conversation has uncertain read-only MCP invocations'){
        $('deleteReadReconcileRow').hidden=false;
        $('deleteError').textContent='Some read-only MCP requests may have completed without a receipt. Acknowledge them and try again to delete.';
      }else $('deleteError').textContent=reason;
    }
    finally{confirm.disabled=false;}
  })();
};
document.addEventListener?.('pointerdown',event=>{
  const target=event.target as Node|null;
  if(target&&!$('sessionMenu').contains(target)&&!menuAnchor?.contains(target))closeSessionMenu();
});
document.addEventListener?.('keydown',event=>{
  if(event.key==='Escape'&&!$('sessionMenu').hidden){
    event.preventDefault();
    closeSessionMenu(true);
  }
});
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

type CapabilitySnapshot={
  skills:Array<{id:string;name:string;description:string;version:string;revision:string|null;installed:boolean;enabled:boolean;loadFailure:string|null;source:'bundled'|'git';sourceRef?:string}>;
  integrations:Array<{id:string;label:string;enabled:boolean;configured:boolean;state:string;availableTools:string[]}>;
};
async function drawCapabilities(snapshot:CapabilitySnapshot){
  const parent=$('capabilitiesContent');
  parent.replaceChildren();
  for(const [title,kind,items] of [
    ['Skills','skills',snapshot.skills],
    ['Integrations','integrations',snapshot.integrations]
  ] as const){
    const group=el('section','capabilities-group','');
    group.append(el('h3','',title));
    for(const item of items){
      const row=el('div','capability-row','');
      const label=document.createElement('label');
      const check=document.createElement('input');
      check.type='checkbox';check.checked=item.enabled;
      const isSkill='name' in item;
      const available=isSkill?item.installed:item.configured;
      check.disabled=!available;check.setAttribute('aria-label','Enable '+(isSkill?item.name:item.label));
      const description=isSkill?item.description:(item.availableTools.length?item.availableTools.length+' approved read tools':'Read-only MCP');
      const info=el('span','','');
      info.append(el('span','capability-name',isSkill?item.name:item.label),
        el('div','capability-description',description));
      if(isSkill&&item.sourceRef)info.append(el('div','capability-description',item.sourceRef));
      label.append(check,info);
      const state=isSkill?(item.loadFailure??'v'+item.version):item.state;
      row.append(label,el('span','capability-state',state));
      check.onchange=()=>{
        check.disabled=true;
        void (async()=>{
          try{
            const response=await api('/capabilities/'+kind+'/'+item.id,{method:'PATCH',body:JSON.stringify({enabled:check.checked})});
            $('capabilitiesError').textContent='';
            await drawCapabilities(await response.json() as CapabilitySnapshot);
          }catch(e){
            $('capabilitiesError').textContent=text(e);
            check.checked=!check.checked;check.disabled=false;
          }
        })();
      };
      if(isSkill&&item.source==='git'){
        const remove=document.createElement('button');
        remove.type='button';remove.textContent='Remove';remove.className='capability-remove';
        remove.setAttribute('aria-label','Remove reviewed Skill '+item.name);
        remove.onclick=()=>{
          if(!window.confirm('Remove reviewed Skill '+item.name+'? Its instructions will no longer load in new tasks.'))return;
          remove.disabled=true;
          void (async()=>{
            try{
              const response=await api('/skills/git/'+item.id,{method:'DELETE'});
              await drawCapabilities(await response.json() as CapabilitySnapshot);
              $('capabilitiesError').textContent='';
            }catch(e){remove.disabled=false;$('capabilitiesError').textContent=text(e);}
          })();
        };
        row.append(remove);
      }
      group.append(row);
    }
    parent.append(group);
  }
}
$<HTMLButtonElement>('openCapabilities').onclick=()=>{
  $<HTMLDialogElement>('capabilitiesDialog').showModal();
  $('capabilitiesContent').textContent='Loading…';
  $('capabilitiesError').textContent='';
  void get<CapabilitySnapshot>('/capabilities').then(drawCapabilities).catch(e=>{$('capabilitiesError').textContent=text(e);});
  closeSidebar();
};
$<HTMLButtonElement>('closeCapabilities').onclick=()=>$<HTMLDialogElement>('capabilitiesDialog').close();

type GitSkillPreview={
  previewId:string;source:{owner:string;repo:string;commit:string;path:string};
  name:string;description:string;version:string;sha256:string;content:string;
};
let stagedGitSkill:GitSkillPreview|null=null;
let gitSkillPreviewGeneration=0;
$<HTMLDialogElement>('capabilitiesDialog').onclose=()=>clearGitSkillReview();
function gitSkillFormSource(){
  return {
    owner:$<HTMLInputElement>('gitSkillOwner').value.trim(),
    repo:$<HTMLInputElement>('gitSkillRepo').value.trim(),
    commit:$<HTMLInputElement>('gitSkillCommit').value.trim().toLowerCase(),
    path:$<HTMLInputElement>('gitSkillPath').value.trim()
  };
}
function clearGitSkillReview(){
  // Increment even when the preview is still being fetched; no prior
  // promise may reinstate its staged contents after an input edit.
  gitSkillPreviewGeneration++;
  stagedGitSkill=null;
  $('gitSkillReview').hidden=true;
  $('gitSkillReviewText').textContent='';
  $<HTMLInputElement>('gitSkillAcknowledge').checked=false;
  $<HTMLButtonElement>('gitSkillInstall').disabled=true;
}
for(const id of ['gitSkillOwner','gitSkillRepo','gitSkillCommit','gitSkillPath'])
  $<HTMLInputElement>(id).oninput=clearGitSkillReview;
$<HTMLInputElement>('gitSkillAcknowledge').onchange=()=>{
  $<HTMLButtonElement>('gitSkillInstall').disabled=
    !stagedGitSkill||!$<HTMLInputElement>('gitSkillAcknowledge').checked;
};
$<HTMLFormElement>('gitSkillPreviewForm').onsubmit=event=>{
  event.preventDefault();clearGitSkillReview();
  const button=$<HTMLButtonElement>('gitSkillPreviewButton');button.disabled=true;
  $('capabilitiesError').textContent='';
  const payload=gitSkillFormSource();
  const generation=gitSkillPreviewGeneration;
  void (async()=>{
    try{
      const response=await api('/skills/git/preview',{method:'POST',body:JSON.stringify(payload)});
      const snapshot=await response.json() as GitSkillPreview;
      // Drop stale results even if the form was edited and changed back,
      // or a later request succeeded first.
      if(generation!==gitSkillPreviewGeneration ||
        JSON.stringify(payload)!==JSON.stringify(gitSkillFormSource()))return;
      stagedGitSkill=snapshot;
      $('gitSkillReviewName').textContent=snapshot.name+' · '+snapshot.version;
      $('gitSkillReviewSource').textContent=
        snapshot.source.owner+'/'+snapshot.source.repo+' @ '+snapshot.source.commit+' / '+snapshot.source.path;
      $('gitSkillReviewDigest').textContent='SHA-256 '+snapshot.sha256;
      // Untrusted preview is rendered ONLY as text, never as HTML.
      $('gitSkillReviewText').textContent=snapshot.content;
      $('gitSkillReview').hidden=false;
    }catch(e){
      if(generation===gitSkillPreviewGeneration)
        $('capabilitiesError').textContent=text(e);
    }
    finally{button.disabled=false;}
  })();
};
$<HTMLButtonElement>('gitSkillInstall').onclick=()=>{
  const staged=stagedGitSkill;
  if(!staged||!$<HTMLInputElement>('gitSkillAcknowledge').checked)return;
  const button=$<HTMLButtonElement>('gitSkillInstall');button.disabled=true;
  void (async()=>{
    try{
      const response=await api('/skills/git/install',{method:'POST',
        body:JSON.stringify({previewId:staged.previewId,sha256:staged.sha256,acknowledged:true})});
      const result=await response.json() as {capabilities:CapabilitySnapshot};
      await drawCapabilities(result.capabilities);
      clearGitSkillReview();$<HTMLFormElement>('gitSkillPreviewForm').reset();
      $('capabilitiesError').textContent='';
    }catch(e){$('capabilitiesError').textContent=text(e);}
    finally{button.disabled=!stagedGitSkill||!$<HTMLInputElement>('gitSkillAcknowledge').checked;}
  })();
};
