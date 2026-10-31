import type { AgentProgress } from './agent-progress.js';

const active=new Set(['queued','running','waiting_children','awaiting_approval']);
const title=(value:string)=>value.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const shorten=(value:string,max:number)=>value.length>max?value.slice(0,max-1)+'…':value;
function element(tag:string,className:string,value=''):HTMLElement {
  const node=document.createElement(tag);
  node.className=className;
  node.textContent=value;
  return node;
}

/** Stable, expandable progress beside a regular chat response. The input is
 * a server-owned snapshot. No model text is interpreted as HTML or authority.
 */
export function renderInlineAgents(
  details:HTMLElement,agents:readonly AgentProgress[],inspect:(taskId:string)=>void
):void {
  if(!agents.length){details.hidden=true;return;}
  details.hidden=false;
  const summary=details.children[0] as HTMLElement;
  const body=details.children[1] as HTMLElement;
  const running=agents.filter(agent=>active.has(agent.state)).length;
  const attention=agents.filter(agent=>['failed','interrupted','awaiting_approval'].includes(agent.state)).length;
  const text=agents.length+' agent'+(agents.length===1?'':'s')+
    (running?' · '+running+' active':' · finished')+
    (attention?' · '+attention+' need attention':'');
  if(summary.textContent!==text)summary.textContent=text;
  const seen=new Set<string>();
  for(const [index,agent] of agents.entries()) {
    seen.add(agent.id);
    let row=Array.from(body.children).find(child=>(child as HTMLElement).dataset.agentId===agent.id) as HTMLElement|undefined;
    if(!row){
      row=element('div','inline-agent-row');
      row.dataset.agentId=agent.id;
      row.append(element('span','inline-agent-status'),
        element('div','inline-agent-main'),
        element('button','inline-agent-open','Details'));
      const button=row.children[2] as HTMLButtonElement;
      button.type='button';
      button.setAttribute('aria-label','Inspect delegated agent '+agent.id.slice(0,8));
      button.onclick=()=>inspect(agent.id);
    }
    row.className='inline-agent-row depth-'+Math.min(agent.depth,2);
    const state=row.children[0] as HTMLElement;
    const stateText=title(agent.state);
    if(state.textContent!==stateText)state.textContent=stateText;
    state.className='inline-agent-status state-'+agent.state;
    const main=row.children[1] as HTMLElement;
    const heading=title(agent.role)+' · '+shorten(agent.prompt,130);
    // Keep the stable container but rebuild text only on actual changes.
    const lines=[
      heading,
      (agent.dependencies.length?'Depends on '+agent.dependencies.length+' task'+(agent.dependencies.length===1?'':'s'):''),
      (agent.lastTool?'Tool: '+shorten(agent.lastTool.name,48)+' · '+title(agent.lastTool.state):''),
      (agent.reportedSummary?'Agent-reported (unverified): '+shorten(agent.reportedSummary,220):''),
      (['failed','cancelled','interrupted'].includes(agent.state)?'Open details for failure or retry information':'')
    ].filter(Boolean);
    const key=JSON.stringify(lines);
    if(main.dataset.summaryKey!==key){
      main.replaceChildren(element('div','inline-agent-name',lines[0]));
      for(const line of lines.slice(1))main.append(element('div','inline-agent-meta',line));
      main.dataset.summaryKey=key;
    }
    if(body.children[index]!==row)body.insertBefore(row,body.children[index]??null);
  }
  for(const node of Array.from(body.children))
    if(!seen.has((node as HTMLElement).dataset.agentId))node.remove();
}
