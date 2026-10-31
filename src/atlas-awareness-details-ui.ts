import type { AtlasDetail, AtlasDetailView, SeverityCounts } from './atlas-awareness-details.js';
import { reviewPullRequestUrl } from './atlas-awareness-details.js';

const node=(tag:string,klass:string,text?:string):HTMLElement=>{
  const element=document.createElement(tag);
  element.className=klass;
  if(text!==undefined)element.textContent=text;
  return element;
};
const time=(date?:string)=>date&&Number.isFinite(Date.parse(date))
  ?new Date(date).toLocaleString([], {dateStyle:'short',timeStyle:'short'}):'Unknown';
const counts=(values:SeverityCounts)=>Object.entries(values)
  .filter(([,n])=>n>0).map(([severity,n])=>severity.toUpperCase()+' '+n).join(' · ')||'No findings in this result';

/**
 * Saved review receipts are historical evidence, never a live GitHub head.
 * A fresh invocation is required to verify the current PR head again.
 */
export function atlasDetailSummary(detail:AtlasDetail,nowMs=Date.now()):{title:string;status:string;rows:string[]} {
  switch(detail.kind){
    case 'project':return {title:detail.label??'Atlas project',status:'Project read',
      rows:['Project ID: '+detail.projectId]};
    case 'store':return {title:detail.label??'Atlas store',status:'Store read',
      rows:['Store ID: '+detail.storeId,'Project ID: '+detail.projectId,
        ...(detail.fieldCount!==undefined?['Schema fields: '+detail.fieldCount]:[])]};
    case 'record':return {title:'Atlas record',status:'Record read',
      rows:['Record ID: '+detail.recordId,'Store ID: '+detail.storeId,
        'Contents are not copied into activity history']};
    case 'review_overview':return {title:'Code Reviews',status:'Overview read',
      rows:['Saved review runs: '+detail.reviewRuns,
        'Finding observations: '+detail.findingObservations]};
    case 'review_findings':return {title:'Review findings',status:'Findings read',
      rows:['Run ID: '+detail.runId,
        'Page: '+detail.pageCount+' findings (offset '+detail.offset+')',
        'Total finding observations: '+detail.total,
        'On this page: '+counts(detail.counts)]};
    case 'review_pr':{
      const latest=detail.latest;
      const checkedAt=detail.currentHead.checkedAt;
      const checkedMs=checkedAt?Date.parse(checkedAt):NaN;
      const historical=!Number.isFinite(checkedMs)||nowMs-checkedMs>5*60_000;
      const when=checkedAt?' at '+time(checkedAt):' (check time unknown)';
      const verdict=detail.latestReviewHead==='current'?'Head matched':
        detail.latestReviewHead==='outdated'?'Head differed':
        detail.latestReviewHead==='no_stored_review'?'No saved review':'Freshness unknown';
      const freshness=(historical?'Historical · ':'')+verdict+when;
      const rows=['Historical snapshot · rerun the Atlas review read to verify the PR now',
        'Recorded rounds: '+detail.recordedRounds,
        'PR status: '+detail.currentHead.state+
          (detail.currentHead.checkedAt?' · checked '+time(detail.currentHead.checkedAt):'')];
      if(latest){
        rows.push('Latest saved verdict: '+latest.verdict.replace(/_/g,' '));
        if(latest.counts)rows.push('Saved severity counts: '+counts(latest.counts));
        rows.push('Reviewed '+time(latest.reviewedAt)+' · head '+latest.headSha.slice(0,10));
      }else rows.push('No stored review verdict');
      return {title:detail.repository+' #'+detail.prNumber,status:freshness,rows};
    }
  }
}

/**
 * Append-only relative to checkout cards; caller remounts only when receipt
 * state changes. Browser links are constructed from validated PR references.
 */
export function renderAtlasDetailViews(parent:HTMLElement,views:AtlasDetailView[]):void {
  for(const view of views){
    const summary=atlasDetailSummary(view.detail);
    const card=node('details','atlas-observed');
    const header=node('summary','atlas-observed-head');
    header.append(node('span','atlas-observed-title',summary.title),
      node('span','atlas-observed-status',summary.status));
    card.append(header);
    const body=node('div','atlas-observed-body');
    for(const line of summary.rows)body.append(node('div','atlas-observed-muted',line));
    body.append(node('div','atlas-observed-muted','Atlas read-only · '+time(view.observedAt)));
    const url=reviewPullRequestUrl(view.detail);
    if(url){
      const anchor=document.createElement('a');
      anchor.href=url;
      anchor.target='_blank';anchor.rel='noopener noreferrer';
      anchor.className='atlas-observed-link';anchor.textContent='Open GitHub PR';
      body.append(anchor);
    }
    card.append(body);parent.append(card);
  }
  parent.hidden=parent.childElementCount===0;
}
