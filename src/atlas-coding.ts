/** Root-only Atlas coding authority. This is a deliberately small vocabulary:
 * no shell, deployment, merge, branch deletion or arbitrary remote writes. */
export const ATLAS_CODING_TOOLS = [
  'workspace_git_create_worktree',
  'workspace_create_file',
  'workspace_patch_file',
  'workspace_delete_file',
  'workspace_git_stage',
  'workspace_git_commit',
  'workspace_git_push_branch',
  'workspace_git_open_pull_request',
  'workspace_run_dev_task'
] as const;
export type AtlasCodingTool = typeof ATLAS_CODING_TOOLS[number];
export const isAtlasCodingTool=(name:string):name is AtlasCodingTool =>
  (ATLAS_CODING_TOOLS as readonly string[]).includes(name);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const validCheckoutId=(value:unknown):value is string =>
  typeof value==='string' && UUID.test(value);
export function atlasCodingCheckouts(raw:string|undefined):string[] {
  if(!raw?.trim())return [];
  const ids=raw.split(',').map(value=>value.trim().toLowerCase());
  if(ids.length>12||ids.some(id=>!validCheckoutId(id))||new Set(ids).size!==ids.length)
    throw new Error('Invalid RELAY_ATLAS_CODING_CHECKOUTS: expected up to 12 unique checkout UUIDs');
  return ids;
}
export function codingCheckoutInput(input:unknown):string|null {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const args=input as Record<string,unknown>;
  const checkout=args.checkoutId??args.workspaceId;
  if(!validCheckoutId(checkout))return null;
  if(args.checkoutId!==undefined&&args.workspaceId!==undefined&&args.checkoutId!==args.workspaceId)return null;
  return checkout.toLowerCase();
}
export interface CodingCheckout {
  id:string;
  nodeId:string;
  branch:string;
  repository:string;
  active:boolean;
  online:boolean;
  capabilities:string[];
}
/** A code-editing session must never modify main, detached HEAD or an unverified node. */
export function codingCheckoutPermitted(checkout:CodingCheckout,tool:AtlasCodingTool):boolean {
  const capability=tool==='workspace_run_dev_task'?'workspace.dev':
    tool.startsWith('workspace_git_')?'workspace.git':'workspace.files';
  if(!checkout.active||!checkout.online||!checkout.capabilities.includes(capability))return false;
  if(tool==='workspace_git_create_worktree')return true; // Base is only used to create an isolated worktree.
  return /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/.test(checkout.branch);
}
export const sensitiveCodingTool=(name:AtlasCodingTool):boolean =>
  ['workspace_git_create_worktree','workspace_git_push_branch','workspace_git_open_pull_request'].includes(name);
