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
function taskUrl(state:State,conversation:string) {
  const query=new URLSearchParams({limit:'50'});
  if(state!=='all' as State)query.set('state',state);
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
  let cursor:string|null=null;
  let hasMore=false;
  let listEpoch=0;
  let detailEpoch=0;
  let pendingList=false;
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
    control.dataset.status=state;
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
  function renderRows() {
    const needle=search.value.trim().toLowerCase();
    const ordered=[...tasks.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const filtered=ordered.filter(task=>{
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
      row.children[1].textContent=label(task.state)+' · '+short(source,35)+' · '+timestamp(task.createdAt)+(relations?' · '+relations:'');
      row.children[2].textContent=short(task.error||task.result||'',135);
      row.title=task.prompt;
      if(list.children[index]!==row)list.insertBefore(row,list.children[index]??null);
    }
    if(!filtered.length&&!pendingList&&tasks.size===0) {
      const empty=node('p','task-feedback','No tasks match this filter.');
      list.append(empty);
    }
    more.hidden=!hasMore;
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
  async function firstPage() {
    if(pendingList||!visible)return;
    pendingList=true;
    const generation=listEpoch;
    try {
      const response=await read<Page>(taskUrl(status as State,conversation));
      if(generation!==listEpoch||!visible)return;
      for(const task of response.tasks)tasks.set(task.id,task);
      if(cursor===null) {cursor=response.nextCursor;hasMore=response.hasMore;}
      // An idle refresh updates the newest rows without discarding older pages.
      countView(response.counts);
      message('');
      renderRows();
    } catch(error) {
      if(generation===listEpoch)message('Connection unavailable — displaying last received task data. '+errorText(error));
    } finally {pendingList=false;}
  }
  async function older() {
    if(!cursor||!hasMore||!visible||pendingList)return;
    more.disabled=true;
    const generation=listEpoch;
    try {
      const url=taskUrl(status as State,conversation)+'&cursor='+encodeURIComponent(cursor);
      const response=await read<Page>(url);
      if(generation!==listEpoch||!visible)return;
      for(const task of response.tasks)tasks.set(task.id,task);
      cursor=response.nextCursor;hasMore=response.hasMore;
      renderRows();
    } catch(error) {message(errorText(error));}
    finally {more.disabled=false;}
  }
  async function reset() {
    listEpoch++;
    cursor=null;hasMore=false;tasks.clear();rows.clear();list.replaceChildren();
    message('Loading tasks…');
    if(!visible)return;
    await firstPage();
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
      detail.append(node('p','task-result',task.result.length>2000?task.result.slice(0,2000)+'…':task.result));
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
      detail.append(node('p','task-detail-meta','Usage: '+tokens+' tokens'+(incomplete?' (incomplete)':'')+' · $'+cost.toFixed(4)+(usage.some(u=>u.costKind==='unknown')?' (cost unknown)':'')));
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
    for(const [id,row] of known)if(!shown.has(id))row.remove();
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
          event.invocationId?'Invocation: '+event.invocationId:''
        ].filter(Boolean);
        if(labels.length)item.append(node('p','task-event-fields',labels.join(' · ')));
      }
      if(eventList.children[index]!==item)eventList.insertBefore(item,eventList.children[index]??null);
    }
    if(!items.length)eventList.append(node('p','task-feedback','No recorded events yet.'));
    if(eventMoreButton) {
      eventMoreButton.hidden=!eventMore;
      eventMoreButton.disabled=eventLoading;
    }
  }
  async function loadEvents() {
    if(eventLoading||!selected||!selectedData||!visible)return;
    const generation=detailEpoch;
    const conversationId=selectedData.task.conversationId;
    eventLoading=true;
    try {
      const replay=await read<{events:ExecutionEvent[];nextCursor:number;hasMore:boolean}>('/sessions/'+conversationId+'/events?after='+eventCursor);
      if(!visible||generation!==detailEpoch)return;
      const seen=new Set(events.map(event=>event.id));
      for(const event of replay.events) {
        if(event.taskId!==selected||event.type==='delta'||seen.has(event.id))continue;
        seen.add(event.id);events.push(event);
      }
      if(events.length>120)events=events.slice(-120);
      eventCursor=replay.nextCursor;
      eventMore=replay.hasMore;
      renderEvents();
    } catch(error) {
      if(generation===detailEpoch&&eventList)eventList.append(node('p','task-error','Activity unavailable: '+errorText(error)));
      eventMore=false;
    } finally {
      eventLoading=false;
      if(eventMoreButton) {eventMoreButton.hidden=!eventMore;eventMoreButton.disabled=false;}
    }
  }
  async function inspect(id:string) {
    selected=id;
    detailEpoch++;
    const generation=detailEpoch;
    events=[];eventCursor=0;eventMore=false;
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
    if(busyAction||!visible)return;
    busyAction=true;
    try {
      const response=await read<{task?:Task}>(path,{method:'POST',body:JSON.stringify(payload)});
      if(!visible)return;
      await firstPage();
      if(retry&&response.task) {
        message('Retry queued in a new conversation.');
        await inspect(response.task.id);
      } else await inspect(id);
    } catch(error) {
      message('Action not confirmed: '+errorText(error));
      if(selected===id)await inspect(id);
    } finally {busyAction=false;}
  }
  async function refreshSelected() {
    if(!selected||!visible||busyAction)return;
    const id=selected,generation=detailEpoch;
    try {
      const data=await read<Detail>('/task-console/tasks/'+id);
      if(!visible||generation!==detailEpoch)return;
      if(detailVersion(data)!==selectedFingerprint)drawDetail(data);
      if(!eventMore)await loadEvents();
    } catch(error) {
      message('Task details may be stale: '+errorText(error));
    }
  }
  function schedule() {
    if(timer)clearTimeout(timer);
    if(!visible)return;
    timer=setTimeout(async()=>{
      if(visible&&document.visibilityState!=='hidden') {
        await firstPage();
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
  byId('taskRefresh').onclick=()=>{void loadConversations().then(()=>reset()).catch(error=>message(errorText(error)));};
  return {show,hide,get visible(){return visible;}};
}
