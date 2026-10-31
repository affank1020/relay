import { projectAtlasCheckouts, type AtlasCheckoutView, type AtlasAwarenessEvent } from './atlas-awareness.js';
import { projectAtlasDetails, type AtlasDetailView } from './atlas-awareness-details.js';
import { renderAtlasCheckoutViews } from './atlas-awareness-ui.js';
import { renderAtlasDetailViews } from './atlas-awareness-details-ui.js';

export interface AtlasAwarenessRow {
  awareness:HTMLElement;
  awarenessKey:string;
}

/**
 * Preserve the existing inline chat DOM unless relevant Atlas evidence,
 * freshness or the operator-configured web origin changes.
 */
export function renderAtlasAwarenessRow(
  row:AtlasAwarenessRow,taskId:string,
  checkouts:ReadonlyArray<AtlasCheckoutView>,details:ReadonlyArray<AtlasDetailView>,
  atlasWebOrigin?:string,now=Date.now()
):boolean {
  const matching=checkouts.filter(view=>view.taskId===taskId);
  const matchingDetails=details.filter(view=>view.taskId===taskId);
  const key=JSON.stringify([
    matching,matchingDetails,
    matching.map(view=>view.gitObservedAt&&now-Date.parse(view.gitObservedAt)>5*60_000?'stale':'recent'),
    matchingDetails.map(view=>{
      const at=view.detail.kind==='review_pr'?view.detail.currentHead.checkedAt:undefined;
      return !at||!Number.isFinite(Date.parse(at))||now-Date.parse(at)>5*60_000
        ?'historical':'recent';
    }),
    // A changed/removed origin must invalidate old links even if no Atlas
    // receipt, replay or snapshot has changed.
    atlasWebOrigin??null
  ]);
  if(row.awarenessKey===key)return false;
  renderAtlasCheckoutViews(row.awareness,[...matching],atlasWebOrigin);
  renderAtlasDetailViews(row.awareness,[...matchingDetails],atlasWebOrigin);
  row.awarenessKey=key;
  return true;
}

/** Refresh currently mounted cards without replacing chat turns or re-fetching events. */
export function refreshAtlasAwarenessRows(
  rows:ReadonlyMap<string,AtlasAwarenessRow>,
  observations:ReadonlyArray<AtlasAwarenessEvent>,atlasWebOrigin?:string,now=Date.now()
):void {
  if(rows.size===0)return;
  const checkouts=projectAtlasCheckouts(observations);
  const details=projectAtlasDetails(observations);
  for(const [taskId,row] of rows)renderAtlasAwarenessRow(row,taskId,checkouts,details,atlasWebOrigin,now);
}
