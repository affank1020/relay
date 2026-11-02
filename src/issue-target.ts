/** A user-supplied GitHub issue URL is an exact source identity, not a
 * repository-search suggestion. This parser never fetches or grants access. */
export interface IssueTarget { owner:string; repo:string; number:number; url:string }
export function explicitIssueTarget(prompt:string):IssueTarget|null {
  const pattern=/https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,38})\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,99})\/issues\/([1-9][0-9]{0,8})(?=$|[\\s\\)\\]}>?#])/g;
  let match:RegExpExecArray|null;
  const found=new Map<string,IssueTarget>();
  while((match=pattern.exec(prompt))) {
    const number=Number(match[3]);
    if(!Number.isSafeInteger(number))continue;
    const owner=match[1],repo=match[2];
    const key=owner.toLowerCase()+'/'+repo.toLowerCase()+'#'+number;
    found.set(key,{owner,repo,number,url:`https://github.com/${owner}/${repo}/issues/${number}`});
    if(found.size>1)return null; // Multiple distinct tasks: don't pick one.
  }
  return found.values().next().value??null;
}
/** Only validated identifiers enter trusted system context; not raw URL text. */
export function issueTargetInstruction(prompt:string,hasIssueRead:boolean):string {
  const target=explicitIssueTarget(prompt);
  if(!target)return '';
  const identity=`owner=${JSON.stringify(target.owner)}, repo=${JSON.stringify(target.repo)}, issue_number=${target.number}`;
  return '\\nThe user explicitly supplied this GitHub issue identity: '+identity+
    '. It is not a name search. Do not substitute a similarly named public repository (e.g. meta/relay) or call GitHub search_repositories for this URL. '+
    (hasIssueRead?'First use mcp__github__issue_read with those exact arguments to inspect the issue. ':
      'The exact GitHub issue_read tool is not enabled; report that blocker instead of searching for substitutes. ');
}
