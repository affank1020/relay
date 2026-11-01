import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubWriteRepositories, approvedGitHubWriteArgs } from '../src/integrations/github-writes.js';
const argumentsForComment={owner:'affank1020',repo:'relay',issue_number:28,body:'Explicitly approved discussion'};
test('GitHub write repositories are operator-only, exact and bounded',()=>{
  assert.deepEqual(githubWriteRepositories(undefined),[]);
  assert.deepEqual(githubWriteRepositories('affank1020/Relay,Demo/repo'),['affank1020/relay','demo/repo']);
  for(const raw of ['owner/*','owner/repo,owner/REPO','../repo','a/repo,a/repo',
    'https://example.com/repo','owner/repo/path','owner/.','a/repo,',Array.from({length:9},(_,i)=>'owner/repo'+i).join(',')])
    assert.throws(()=>githubWriteRepositories(raw),/Invalid|Duplicate/);
  assert.deepEqual(approvedGitHubWriteArgs('add_issue_comment',argumentsForComment,['affank1020/relay']),
    argumentsForComment);
  for(const invalid of [
    {...argumentsForComment,repo:'atlas'}, {...argumentsForComment,issue_number:0},
    {...argumentsForComment,issue_number:'28'}, {...argumentsForComment,body:''},
    {...argumentsForComment,body:'x'.repeat(8001)}, {...argumentsForComment,command:'push'},
    {...argumentsForComment,body:'bad\u0000body'}
  ])assert.equal(approvedGitHubWriteArgs('add_issue_comment',invalid,['affank1020/relay']),null);
  assert.equal(approvedGitHubWriteArgs('push_files',argumentsForComment,['affank1020/relay']),null);
  assert.deepEqual(approvedGitHubWriteArgs('create_issue',
    {owner:'affank1020',repo:'relay',title:'Found a regression'},['affank1020/relay']),
    {owner:'affank1020',repo:'relay',title:'Found a regression'});
});
