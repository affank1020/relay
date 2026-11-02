import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {atlasCodingCheckouts,codingCheckoutInput,codingCheckoutPermitted,
  isAtlasCodingTool,sensitiveCodingTool,type CodingCheckout} from '../src/atlas-coding.js';

test('coding allowlist is explicit and UUID-scoped',()=>{
  const id=randomUUID();
  assert.deepEqual(atlasCodingCheckouts(id.toUpperCase()),[id]);
  assert.deepEqual(atlasCodingCheckouts(''),[]);
  assert.throws(()=>atlasCodingCheckouts('all'),/Invalid/);
  assert.throws(()=>atlasCodingCheckouts(id+','+id),/Invalid/);
  assert.equal(codingCheckoutInput({checkoutId:id,workspaceId:'other'}),null);
  assert.equal(codingCheckoutInput({workspaceId:id}),id);
  assert.equal(codingCheckoutInput({path:'src/a.ts'}),null);
});
test('only narrowly scoped Atlas development operations are coding tools',()=>{
  assert.equal(isAtlasCodingTool('workspace_patch_file'),true);
  assert.equal(isAtlasCodingTool('workspace_git_open_pull_request'),true);
  for(const name of ['workspace_git_switch_branch','workspace_git_remove_worktree',
    'workspace_git_clone_repository','workspace_run_shell','update_node'])
    assert.equal(isAtlasCodingTool(name),false);
  assert.equal(sensitiveCodingTool('workspace_git_push_branch'),true);
  assert.equal(sensitiveCodingTool('workspace_patch_file'),false);
});
test('edits require an active, online, capability-advertising atlas/* worktree',()=>{
  const base:CodingCheckout={id:randomUUID(),nodeId:randomUUID(),repository:'owner/repo',
    branch:'main',active:true,online:true,capabilities:['workspace.files','workspace.git','workspace.dev']};
  assert.equal(codingCheckoutPermitted(base,'workspace_git_create_worktree'),true);
  assert.equal(codingCheckoutPermitted(base,'workspace_patch_file'),false);
  assert.equal(codingCheckoutPermitted({...base,branch:'atlas/coding-issue'},'workspace_patch_file'),true);
  assert.equal(codingCheckoutPermitted({...base,branch:'atlas/coding-issue',online:false},'workspace_patch_file'),false);
  assert.equal(codingCheckoutPermitted({...base,branch:'atlas/coding-issue',capabilities:['workspace.git']},'workspace_patch_file'),false);
  assert.equal(codingCheckoutPermitted({...base,branch:'atlas/coding-issue'},'workspace_run_dev_task'),true);
});
