// GitHub is the *only* provider with a reviewed, opt-in mutation vocabulary.
// A tool name and discovered MCP JSON schema are not authority to mutate.
export const GITHUB_WRITES=['add_issue_comment','create_issue'] as const;
export type GitHubWriteName=typeof GITHUB_WRITES[number];
const repoSegment=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ownerSegment=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const control=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function githubWriteRepositories(raw:string|undefined):string[] {
  if(!raw?.trim())return [];
  const entries=raw.split(',').map(s=>s.trim());
  if(entries.length>8||entries.some(s=>{
    const pieces=s.split('/');
    return pieces.length!==2||!ownerSegment.test(pieces[0])||
      !repoSegment.test(pieces[1])||pieces[1]==='.'||pieces[1]==='..';
  }))throw new Error('Invalid RELAY_GITHUB_WRITE_REPOS: use up to eight exact owner/repo entries');
  const canonical=entries.map(s=>s.toLowerCase());
  if(new Set(canonical).size!==canonical.length)
    throw new Error('Duplicate RELAY_GITHUB_WRITE_REPOS entry');
  return canonical;
}
export function isGitHubWrite(name:string):name is GitHubWriteName {
  return GITHUB_WRITES.some(value=>value===name);
}

export function approvedGitHubWriteArgs(
  name:string, input:unknown, allowed:readonly string[]
):Record<string,unknown>|null {
  if(!isGitHubWrite(name)||!input||typeof input!=='object'||Array.isArray(input))return null;
  const v=input as Record<string,unknown>;
  if(typeof v.owner!=='string'||!ownerSegment.test(v.owner)||
    typeof v.repo!=='string'||!repoSegment.test(v.repo)||
    !allowed.includes((v.owner+'/'+v.repo).toLowerCase()))return null;
  const permitted=name==='add_issue_comment'
    ?['owner','repo','issue_number','body']
    :['owner','repo','title','body'];
  if(Object.keys(v).some(key=>!permitted.includes(key)))return null;
  if(name==='add_issue_comment'){
    if(!Number.isSafeInteger(v.issue_number)||Number(v.issue_number)<1||
      Number(v.issue_number)>1_000_000_000||typeof v.body!=='string'||
      !v.body.trim()||v.body.length>8000||control.test(v.body))return null;
    return {owner:v.owner,repo:v.repo,issue_number:v.issue_number,body:v.body};
  }
  if(typeof v.title!=='string'||!v.title.trim()||v.title.length>200||
    control.test(v.title)||v.body!==undefined&&(typeof v.body!=='string'||
      v.body.length>8000||control.test(v.body)))return null;
  return {owner:v.owner,repo:v.repo,title:v.title,...(v.body===undefined?{}:{body:v.body})};
}
