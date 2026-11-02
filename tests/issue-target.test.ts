import assert from 'node:assert/strict';
import {test} from 'node:test';
import {explicitIssueTarget,issueTargetInstruction} from '../src/issue-target.js';

test('pin literal and Markdown issue URLs to the exact owner, repo and issue',()=>{
  for(const prompt of [
    'Implement https://github.com/affank1020/relay/issues/65',
    'Implement [Relay issue #65](https://github.com/affank1020/relay/issues/65).',
    'Implement [https://github.com/affank1020/relay/issues/65](https://github.com/affank1020/relay/issues/65)',
  ]){
    assert.deepEqual(explicitIssueTarget(prompt),{owner:'affank1020',repo:'relay',number:65,
      url:'https://github.com/affank1020/relay/issues/65'});
    const hint=issueTargetInstruction(prompt,true);
    assert.match(hint,/repo="relay", issue_number=65/);
    assert.match(hint,/mcp__github__issue_read/);
    assert.match(hint,/Do not substitute/);
  }
});
test('do not guess a target for ambiguous or invalid URLs',()=>{
  for(const prompt of [
    'Try the Relay project', 'https://github.com/meta/relay',
    'https://github.com/affank1020/relay/issues/0',
    'https://github.com/affank1020/relay/issues/65/other',
    'https://evil.github.com/affank1020/relay/issues/65',
    'https://github.com/affank1020/relay/issues/65 https://github.com/meta/relay/issues/65'
  ])assert.equal(explicitIssueTarget(prompt),null);
  const hint=issueTargetInstruction('Fix https://github.com/affank1020/relay/issues/65',false);
  assert.match(hint,/not enabled/);
  assert.doesNotMatch(hint,/First use mcp__/);
});
