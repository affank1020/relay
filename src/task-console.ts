import type { Approval, ExecutionEvent, State, Task } from './store.js';

type Request = (path:string,options?:RequestInit)=>Promise<Response>;
type Counts = Partial<Record<State,number>>;
type Page = {tasks:Task[];nextCursor:string|null;hasMore:boolean;counts:Counts};
type Conversation = {id:string;title:string;modelKey?:string|null};
type Detail = {task:Task;conversation:Conversation|null;children:Task[];approvals:Array<Pick<Approval,'id'|'tool'|'state'> & {args:unknown}>};
const states:State[]=['running','queued','awaiting_approval','failed','interrupted','completed','cancelled'];
const actionable=new Set<State>(['running','queued','awaiting_approval']);
const retryable=new Set<State>(['failed','cancelled','interrupted']);

function byId<T extends HTMLElement=HTMLElement>(id:string):T {
  const element=document.getElementById(id);
  if(!element)throw new Error('Missing task console element '+id);
  return element as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag:K,className:string,value=''):HTMLElementTagNameMap[K] {
  const element=document.createElement(tag);
  element.className=className;
  element.textContent=value;
  return element;
}
function short(value:string,max=110) {
  const oneLine=value.replace(/\s+/g,' ').trim();
  return oneLine.length>max?oneLine.slice(0,max-1)+'…':oneLine;
}
function timestamp(value:string) {
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'Unknown time':date.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
}
function label(value:string|null) {
  return (value??'Unknown').replace(/^atlas_/,'').replace(/_/g,' ').replace(/\b\w/g,match=>match.toUpperCase());
}
function button(text:string,action:()=>void,className='action') {
  const element=node('button',className,text);
  element.type='button';
  element.onclick=action;
  return element;
}
function errorText(error:unknown) {return error instanceof Error?error.message:'Request failed';}
function taskUrl(state:string,conversation:string) {
  const query=new URLSearchParams({limit:'50'});
  if(state!=='all')query.set('state',state);
  if(conversation)query.set('conversationId',conversation);
  return '/task-console/tasks?'+query.toString();
}

export function mountTaskConsole(request:Request,openConversation:(id:string)=>Promise<void>) {
  const root=byId('taskConsole');
  const list=byId('taskRows');
  const detail=byId('taskDetail');
  const feedback=byId('taskFeedback');
  const more=byId<HTMLButtonElement>('taskMore');
  const search=byId<HTMLInputElement>('taskSearch');
  const conversationFilter=byId<HTMLSelectElement>('taskConversationFilter');
  const countsRoot=byId('taskCounts');
  const countNodes=new Map<string,HTMLElement>();
  const rows=new Map<string,HTMLButtonElement>();
  const tasks=new Map<string,Task>();
  const conversations=new Map<string,Conversation>();
  let visible=false;
  let status='all';
  let conversation='';
  let selected:string|null=null;
  let selectedData:Detail|null=null;
  let selectedFingerprint='';
  // Live replaces only the newest page. History freezes loaded rows and
  // moves ONE exclusive cursor strictly toward older persisted row IDs.
  let mode:'live'|'history'='live';
  let cursor:string|null=null;
  let hasMore=false;
  let initialPageLoaded=false;
  let liveFingerprint='';
  let listEpoch=0;
  let detailEpoch=0;
  let pendingEpoch=-1;
  let loadingOlder=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let events:ExecutionEvent[]=[];
  let eventCursor=0;
  let eventMore=false;
  let eventLoading=false;
  let eventList:HTMLElement|null=null;
  let eventMoreButton:HTMLButtonElement|null=null;
  let busyAction=false;

  async function read<T>(path:string,options?:RequestInit) {return await (await request(path,options)).json() as T;}
  function message(value:string) {feedback.textContent=value;}
  const filters=['all',...states];
  for(const state of filters) {
    const control=button('',()=>{
      if(state===status)return;
      status=state;
      void reset();
    },'task-count');
    const value=node('strong','','0');
    control.append(node('span','',state==='all'?'All':label(state)),value);
    countsRoot.append(control);
    countNodes.set(state,value);
  }
  function countView(counts:Counts) {
    const sum=states.reduce((total,state)=>total+(counts[state]??0),0);
    for(const state of filters) {
      const value=countNodes.get(state);
      if(value)value.textContent=String(state==='all'?sum:counts[state as State]??0);
      const control=value?.parentElement;
      control?.classList.toggle('active',state===status);
      control?.setAttribute('aria-pressed',String(state===status));
    }
  }
  function fingerprint(page:Page) {
    return JSON.stringify([page.tasks.map(task=>[task.id,task.state]),
      states.map(state=>page.counts[state]??0)]);
  }
  function historyNotice(updates=false) {
    message(updates?'New task updates available · Refresh':'History · Refresh for latest tasks');
  }
  function renderRows() {
    const needle=search.value.trim().toLowerCase();
    const ordered=[...tasks.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const filtered=ordered.filter(task=>{
      if(status!=='all'&&task.state!==status)return false;
      if(conversation&&task.conversationId!==conversation)return false;
      const conversationName=conversations.get(task.conversationId)?.title??'';
      return !needle||[task.prompt,task.state,conversationName,task.id].some(value=>value.toLowerCase().includes(needle));
    });
    const wanted=new Set(filtered.map(task=>task.id));
    for(const [id,row] of rows)if(!wanted.has(id)){row.remove();rows.delete(id);}
    for(const [index,task] of filtered.entries()) {
      let row=rows.get(task.id);
      if(!row) {
        row=node('button','task-row') as HTMLButtonElement;
        row.type='button';
        row.append(node('span','task-row-title'),node('span','task-row-meta'),node('span','task-row-result'));
        row.onclick=()=>{void inspect(task.id);};
        rows.set(task.id,row);
      }
      row.classList.toggle('selected',selected===task.id);
      row.setAttribute('aria-pressed',String(selected===task.id));
      row.children[0].textContent=short(task.prompt,145)||'Untitled task';
      const source=conversations.get(task.conversationId)?.title??'Unavailable conversation';
      const relations=[task.parentId?'Delegated':'',task.dependencies.length?task.dependencies.length+' dependencies':'',task.attemptOf?'Retry':''].filter(Boolean).join(' · ');
      const model=conversations.get(task.conversationId)?.modelKey;
      row.children[1].textContent=label(task.state)+' · '+short(source,35)+(model?' · '+short(model,28):'')+' · '+timestamp(task.createdAt)+(relations?' · '+relations:'');
      row.children[2].textContent=short(task.error||task.result||'',135);
      row.title=task.prompt;
      if(list.children[index]!==row)list.insertBefore(row,list.children[index]??null);
    }
    const placeholder=list.querySelector('.task-rows-empty');
    if(!filtered.length&&initialPageLoaded) {
      if(!placeholder)list.append(node('p','task-feedback task-rows-empty','No tasks match this filter.'));
    } else placeholder?.remove();
    more.hidden=!hasMore;
    more.disabled=loadingOlder;
  }
  async function loadConversations() {
    const response=await read<{sessions:Conversation[]}>('/sessions');
    conversations.clear();
    for(const session of response.sessions)conversations.set(session.id,session);
    const previous=conversationFilter.value;
    conversationFilter.replaceChildren();
    const all=node('option','','All conversations');all.value='';conversationFilter.append(all);
    for(const session of response.sessions) {
      const option=node('option','',short(session.title,70));
      option.value=session.id;conversationFilter.append(option);
    }
    conversationFilter.value=previous&&conversations.has(previous)?previous:'';
    conversation=conversationFilter.value;
  }
  async function loadLive() {
    if(pendingEpoch===listEpoch||!visible||mode!=='live')return;
    const generation=listEpoch;
    pendingEpoch=generation;
    try {
      const page=await read<Page>(taskUrl(status,conversation));
      if(generation!==listEpoch||!visible||mode!=='live')return;
      // No automatic history accumulation. If a task falls off the newest
      // page, it is recovered only by a deliberate history paging action.
      tasks.clear();
      for(const task of page.tasks)tasks.set(task.id,task);
      cursor=page.nextCursor;hasMore=page.hasMore;
      liveFingerprint=fingerprint(page);
      initialPageLoaded=true;
      countView(page.counts);
      message('');
      renderRows();
    } catch(error) {
      if(generation===listEpoch&&mode==='live')message('Connection unavailable: '+errorText(error));
    } finally {
      if(pendingEpoch===generation)pendingEpoch=-1;
    }
  }
  async function checkHistoryUpdates() {
    if(!visible||mode!=='history')return;
    const generation=listEpoch;
    try {
      const page=await read<Page>(taskUrl(status,conversation));
      if(generation!==listEpoch||!visible||mode!=='history')return;
      // The history snapshot and counts stay untouched; only the notice is
      // updated. State changes and new tasks appear after explicit Refresh.
      historyNotice(fingerprint(page)!==liveFingerprint);
    } catch(error) {
      if(generation===listEpoch&&mode==='history')
        message('History · Update check unavailable: '+errorText(error));
    }
  }
  async function older() {
    if(!visible||!hasMore||!cursor||loadingOlder)return;
    // Enter history immediately so an in-flight live poll cannot replace
    // the frozen first page while the first older request is pending.
    mode='history';
    historyNotice();
    loadingOlder=true;
    renderRows();
    const generation=listEpoch,requestedCursor=cursor;
    try {
      const url=taskUrl(status,conversation)+'&cursor='+encodeURIComponent(requestedCursor);
      const page=await read<Page>(url);
      if(generation!==listEpoch||!visible||mode!=='history')return;
      // Reject nonadvancing or malformed cursor responses rather than creating
      // an endless older-page loop. Repeated IDs are deduplicated by Map.
      if(page.hasMore&&(!page.nextCursor||!/^\d+$/.test(page.nextCursor)||
          Number(page.nextCursor)>=Number(requestedCursor)))
        throw new Error('Invalid task page cursor');
      for(const task of page.tasks)tasks.set(task.id,task);
      cursor=page.nextCursor;hasMore=page.hasMore;
      renderRows();
    } catch(error) {
      if(generation===listEpoch&&mode==='history')message('History unavailable: '+errorText(error));
    } finally {
      if(generation===listEpoch){
        loadingOlder=false;
        renderRows();
      }
    }
  }
  function clearSelection() {
    // Invalidate pending detail/event reads and detached mutation callbacks.
    detailEpoch++;
    selected=null;selectedData=null;selectedFingerprint='';
    events=[];eventCursor=0;eventMore=false;eventLoading=false;
    eventList=null;eventMoreButton=null;
    detail.replaceChildren(node('p','task-feedback','Select a task to inspect its work.'));
  }
  async function reset() {
    listEpoch++;
    mode='live';
    clearSelection();
    cursor=null;hasMore=false;initialPageLoaded=false;liveFingerprint='';
    loadingOlder=false;pendingEpoch=-1;
    tasks.clear();rows.clear();list.replaceChildren();
    message('Loading tasks…');
    if(visible)await loadLive();
  }
  function relation(title:string,ids:string[]) {
    if(!ids.length)return;
    const wrapper=node('div','task-relation','');
    wrapper.append(node('span','task-label',title));
    for(const id of ids) {
      const task=tasks.get(id);
      const action=button(short(task?.prompt||id,90),()=>{void inspect(id);},'task-relation-link');
      action.title=id;
      wrapper.append(action);
    }
    detail.append(wrapper);
  }
  function detailVersion(data:Detail) {
    return [data.task.state,data.task.error,data.task.result.length,data.approvals.map(approval=>approval.id+approval.state).join(','),data.children.map(child=>child.id+child.state).join(',')].join('|');
  }
  function drawDetail(data:Detail) {
    selectedData=data;
    selectedFingerprint=detailVersion(data);
    const task=data.task;
    detail.replaceChildren();
    const heading=node('div','task-detail-head','');
    heading.append(node('h2','',short(task.prompt,180)||'Untitled task'),node('span','task-status state-'+task.state,label(task.state)));
    detail.append(heading);
    const meta=node('div','task-detail-meta','');
    meta.append(node('span','',timestamp(task.createdAt)));
    if(data.conversation?.modelKey)meta.append(node('span','','Model selection: '+data.conversation.modelKey));
    meta.append(node('span','','Task '+task.id.slice(0,8)));
    detail.append(meta);
    const actions=node('div','task-actions','');
    if(data.conversation)actions.append(button('Open conversation',()=>{void openConversation(task.conversationId).catch(error=>message(errorText(error)));}));
    if(actionable.has(task.state)) {
      actions.append(button('Cancel task',()=>{
        if(!window.confirm('Cancel this task? A dispatched operation may not be reversible.'))return;
        void mutate('/tasks/'+task.id+'/cancel',{},task.id);
      },'action task-danger'));
    }
    if(retryable.has(task.state)) {
      actions.append(button('Retry task',()=>{
        if(!window.confirm('I have reconciled any dispatched or uncertain tool effects. Retrying will start a new conversation and could repeat work. Continue?'))return;
        void mutate('/tasks/'+task.id+'/retry',{reconciled:true},task.id,true);
      }));
    }
    detail.append(actions);
    if(task.error)detail.append(node('p','task-error',task.error));
    if(task.result) {
      detail.append(node('h3','task-section-heading','Result'));
      // Full persisted output remains available without navigating away from the task.
      // The pane itself is scroll-bounded in CSS rather than cutting off the response.
      detail.append(node('div','task-result',task.result));
    }
    relation('Parent',task.parentId?[task.parentId]:[]);
    relation('Dependencies',task.dependencies);
    relation('Child tasks',data.children.map(child=>child.id));
    relation('Previous attempt',task.attemptOf?[task.attemptOf]:[]);
    if(data.approvals.length) {
      detail.append(node('h3','task-section-heading','Approvals'));
      for(const approval of data.approvals) {
        const item=node('div','task-approval','');
        const name=node('div','',label(approval.tool)+' · '+label(approval.state));
        item.append(name);
        const disclosure=node('details','','');
        disclosure.append(node('summary','','Action arguments'));
        disclosure.append(node('pre','',JSON.stringify(approval.args,null,2)));
        item.append(disclosure);
        if(approval.state==='pending'&&task.state==='awaiting_approval') {
          const controls=node('div','task-actions','');
          controls.append(button('Approve',()=>{void mutate('/approvals/'+approval.id,{approved:true},task.id);}));
          controls.append(button('Reject',()=>{void mutate('/approvals/'+approval.id,{approved:false},task.id);},'action task-danger'));
          item.append(controls);
        }
        detail.append(item);
      }
    }
    if(task.usage.length) {
      const usage=task.usage;
      const tokens=usage.reduce((sum,u)=>sum+(u.input??0)+(u.output??0),0);
      const incomplete=usage.some(u=>u.input===null||u.output===null);
      const cost=usage.reduce((sum,u)=>sum+(u.costUsd??0),0);
      const priced=usage.some(u=>u.costUsd!==null);
      const costLabel=priced?'$'+cost.toFixed(4)+(usage.some(u=>u.costKind==='estimated')?' estimated':''):'cost unavailable';
      detail.append(node('p','task-detail-meta','Usage: '+tokens+' tokens'+(incomplete?' (incomplete)':'')+' · '+costLabel));
    }
    detail.append(node('h3','task-section-heading','Execution activity'));
    eventList=node('div','task-timeline','');
    detail.append(eventList);
    eventMoreButton=button('Load more activity',()=>{void loadEvents();},'action task-more');
    detail.append(eventMoreButton);
    renderEvents();
  }
  function renderEvents() {
    if(!eventList)return;
    const known=new Map([...eventList.children].map(child=>[(child as HTMLElement).dataset.eventId,child as HTMLElement]));
    const items=events.slice(-120);
    const shown=new Set(items.map(event=>event.id));
    for(const [id,row] of known)if(!id||!shown.has(id))row.remove();
    for(const [index,event] of items.entries()) {
      let item=known.get(event.id);
      if(!item) {
        item=node('div','task-event','');
        item.dataset.eventId=event.id;
        const head=node('div','task-event-head','');
        head.append(node('span','',event.type==='tool'?label(event.tool):label(event.type)),node('span','task-event-state',label(event.state)),node('time','',timestamp(event.timestamp)));
        item.append(head);
        const labels=[
          event.tool?'Tool: '+label(event.tool):'',
          event.atlasOperationId?'Atlas operation: '+event.atlasOperationId:'',
          event.selectedNodeId?'Selected node: '+event.selectedNodeId:'',
          event.executingNodeId?'Executing node (reported receipt): '+event.executingNodeId:'',
          event.agentRunId&&event.agentRunId!==event.taskId?'Agent run: '+event.agentRunId:'',
          event.invocationId?'Invocation: '+event.invocationId:''
        ].filter(Boolean);
        if(labels.length)item.append(node('p','task-event-fields',labels.join(' · ')));
      }
      if(eventList.children[index]!==item)eventList.insertBefore(item,eventList.children[index]??null);
    }
    const placeholder=eventList.querySelector('.task-events-empty');
    if(!items.length){
      const emptyText=eventMore?'Scanning activity history…':'No recorded events yet.';
      if(!placeholder)eventList.append(node('p','task-feedback task-events-empty',emptyText));
      else placeholder.textContent=emptyText;
    } else placeholder?.remove();
    if(eventMoreButton) {
      eventMoreButton.hidden=!eventMore;
      eventMoreButton.disabled=eventLoading;
    }
  }
  async function loadEvents() {
    if(eventLoading||!selected||!selectedData||!visible)return;
    const generation=detailEpoch;
    const taskId=selected;
    const conversationId=selectedData.task.conversationId;
    eventLoading=true;
    try {
      const seen=new Set(events.map(event=>event.id));
      // Existing /sessions/:id/events returns up to 500 events per page across
      // ALL tasks in that conversation. Walk a bounded number of pages per tick
      // so activity for a child task is not stranded behind unrelated events.
      for(let page=0;page<4;page++) {
        const replay=await read<{events:ExecutionEvent[];nextCursor:number;hasMore:boolean}>('/sessions/'+conversationId+'/events?after='+eventCursor);
        if(!visible||generation!==detailEpoch||selected!==taskId)return;
        if(!Number.isSafeInteger(replay.nextCursor)||replay.nextCursor<eventCursor||
            replay.hasMore&&replay.nextCursor===eventCursor)throw new Error('Invalid activity cursor');
        for(const event of replay.events) {
          if(event.taskId!==taskId||event.type==='delta'||seen.has(event.id))continue;
          seen.add(event.id);events.push(event);
        }
        if(events.length>120)events=events.slice(-120);
        eventCursor=replay.nextCursor;
        eventMore=replay.hasMore;
        if(!eventMore)break;
      }
      renderEvents();
    } catch(error) {
      if(generation===detailEpoch&&eventList)eventList.append(node('p','task-error','Activity unavailable: '+errorText(error)));
    } finally {
      if(generation===detailEpoch) {
        eventLoading=false;
        if(eventMoreButton) {eventMoreButton.hidden=!eventMore;eventMoreButton.disabled=false;}
      }
    }
  }
  async function inspect(id:string) {
    selected=id;
    detailEpoch++;
    const generation=detailEpoch;
    events=[];eventCursor=0;eventMore=false;eventLoading=false;
    selectedData=null;selectedFingerprint='';
    renderRows();
    detail.replaceChildren(node('p','task-feedback','Loading task…'));
    try {
      const data=await read<Detail>('/task-console/tasks/'+id);
      if(!visible||generation!==detailEpoch)return;
      drawDetail(data);
      await loadEvents();
    } catch(error) {
      if(generation===detailEpoch)detail.replaceChildren(node('p','task-error','Task unavailable: '+errorText(error)));
    }
  }
  async function mutate(path:string,payload:Record<string,unknown>,id:string,retry=false) {
    if(busyAction||!visible||selected!==id||selectedData?.task.id!==id)return;
    const generation=detailEpoch;
    busyAction=true;
    try {
      const response=await read<{task?:Task}>(path,{method:'POST',body:JSON.stringify(payload)});
      if(!visible||generation!==detailEpoch||selected!==id)return;
      if(mode==='live')await loadLive();
      if(!visible||generation!==detailEpoch||selected!==id)return;
      if(retry&&response.task) {
        message('Retry queued in a new conversation.');
        await inspect(response.task.id);
      } else await inspect(id);
    } catch(error) {
      if(generation===detailEpoch&&selected===id) {
        message('Action not confirmed: '+errorText(error));
        await inspect(id);
      }
    } finally {busyAction=false;}
  }
  async function refreshSelected() {
    if(!selected||!visible||busyAction)return;
    const id=selected,generation=detailEpoch;
    try {
      const data=await read<Detail>('/task-console/tasks/'+id);
      if(!visible||generation!==detailEpoch)return;
      // Selection is independent of list scope, including related tasks
      // and tasks whose state changes while browsing frozen history.
      if(detailVersion(data)!==selectedFingerprint)drawDetail(data);
      // Continue any partial replay on every visible poll; once caught up,
      // the same cursor also picks up new task events.
      await loadEvents();
    } catch(error) {
      if(generation!==detailEpoch||!visible)return;
      // Detached buttons must also be inert: their callbacks are gated by
      // selectedData, not just by whether the action panel remains mounted.
      detailEpoch++;
      selectedData=null;selectedFingerprint='';
      events=[];eventLoading=false;
      detail.replaceChildren(node('p','task-feedback','Task details unavailable. Refresh to retry.'));
      eventList=null;eventMoreButton=null;
      message('Task details may be stale: '+errorText(error));
    }
  }
  function schedule() {
    if(timer)clearTimeout(timer);
    if(!visible)return;
    timer=setTimeout(async()=>{
      if(visible&&document.visibilityState!=='hidden') {
        if(mode==='live')await loadLive();
        else await checkHistoryUpdates();
        await refreshSelected();
      }
      schedule();
    },4000);
  }
  async function show() {
    if(visible)return;
    visible=true;root.hidden=false;
    try {await loadConversations();} catch(error) {message('Conversations unavailable: '+errorText(error));}
    await reset();
    schedule();
  }
  function hide() {
    visible=false;root.hidden=true;
    listEpoch++;detailEpoch++;
    if(timer)clearTimeout(timer);
    timer=undefined;
  }
  search.oninput=renderRows;
  conversationFilter.onchange=()=>{conversation=conversationFilter.value;void reset();};
  more.onclick=()=>{void older();};
  byId('taskRefresh').onclick=()=>{
    void (async()=>{
      try {await loadConversations();}
      catch(error) {message('Conversations unavailable: '+errorText(error));}
      await reset();
    })();
  };
  return {show,hide,get visible(){return visible;}};
}
