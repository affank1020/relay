import type { AtlasCheckoutView } from './atlas-awareness.js';

function element(tag:string,className:string,text?:string):HTMLElement {
  const node=document.createElement(tag);
  node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function time(value?:string):string {
  if(!value)return 'Unknown';
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?new Date(parsed).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'Unknown';
}
function stale(value?:string):boolean {
  return !value || !Number.isFinite(Date.parse(value)) || Date.now()-Date.parse(value)>5*60_000;
}

/** Truncated counts are lower bounds; no inferred exact totals. */
export function gitChangeLabel(view:Pick<AtlasCheckoutView,'dirty'|'changedFiles'|'changedFilesTruncated'>):string {
  if(view.dirty===undefined)return 'Change state unknown';
  if(!view.dirty)return 'Clean';
  if(view.changedFiles===undefined)return 'Changed files not enumerated';
  return view.changedFiles+(view.changedFilesTruncated?'+':'')+' changed '+(view.changedFiles===1&&!view.changedFilesTruncated?'file':'files');
}

/** Context is optional, read-only and scoped to the observed task. */
export function renderAtlasCheckoutViews(parent:HTMLElement,views:AtlasCheckoutView[]):void {
  parent.replaceChildren();
  for(const view of views){
    const card=element('details','atlas-observed');
    const header=element('summary','atlas-observed-head');
    const name=view.name??view.repository??'Checkout';
    const title=element('span','atlas-observed-title',name);
    const status=view.placementSupersededAt?'Previous placement':
      view.placementStatus==='archived'?'Archived':
      view.nodeStatus==='offline'?'Node offline':
      view.lastFailureTool==='workspace_git_status'&&view.lastFailureAt&&
        (!view.gitObservedAt||view.lastFailureAt>view.gitObservedAt)?'Git inspection failed':
      stale(view.gitObservedAt)?'Context only':'Git observed';
    header.append(title,element('span','atlas-observed-status',status));
    card.append(header);
    const body=element('div','atlas-observed-body');
    if(view.repository||view.branch){
      body.append(element('div','atlas-observed-git',
        [view.repository,view.branch].filter(Boolean).join(' · ')));
    }
    if(view.gitObservedAt){
      const changeLabel=gitChangeLabel(view);
      body.append(element('div','atlas-observed-muted',
        changeLabel+' · Git read '+time(view.gitObservedAt)+(stale(view.gitObservedAt)?' (stale)':'')));
    }else{
      body.append(element('div','atlas-observed-muted','Git state not verified'));
    }
    if(view.placementSupersededAt)body.append(element('div','atlas-observed-muted',
      'Checkout placement changed after this observation · '+time(view.placementSupersededAt)));
    if(view.lastFailureTool==='workspace_git_list_worktrees'&&view.lastFailureAt){
      body.append(element('div','atlas-observed-muted','Worktree read failed · '+time(view.lastFailureAt)));
    }
    if(view.nodeId){
      const label=view.nodeName??view.nodeId;
      body.append(element('div','atlas-observed-muted','Assigned Node: '+label+
        (view.nodeStatus?' · '+view.nodeStatus+' at '+time(view.nodeObservedAt):' · state unknown')));
    }
    if(view.rootPath)body.append(element('div','atlas-observed-path',view.rootPath));
    if(view.worktrees?.length){
      const list=element('div','atlas-observed-worktrees');
      for(const tree of view.worktrees){
        list.append(element('div','atlas-observed-muted',
          'Worktree: '+tree.rootPath+(tree.branch?' · '+tree.branch:'')));
      }
      body.append(list);
    }
    body.append(element('div','atlas-observed-muted','Atlas read-only observation · '+time(view.placementObservedAt??view.gitObservedAt)));
    card.append(body);
    parent.append(card);
  }
  parent.hidden=views.length===0;
}
