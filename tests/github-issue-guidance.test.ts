import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubIssueGuidance } from '../src/github-issue-guidance.js';

test('exact GitHub issue requests prefer the authorized issue_read tool',()=>{
  const prompt='Use GitHub MCP to read issue #29 in affank1020/relay. Summarise its requirements.';
  const hint=githubIssueGuidance(prompt,[
    'mcp_github_get_me','mcp_github_search_code','mcp_github_search_repositories',
    'mcp_github_issue_read'
  ]);
  assert.match(hint,/mcp_github_issue_read/);
  assert.match(hint,/method=get/);
  assert.match(hint,/owner, repo and issue_number/);
  assert.match(hint,/Only summarize the issue after the issue_read response succeeds/);
  assert.match(hint,/search_code.*search_repositories/);
});
test('GitHub issue guidance fails closed when issue_read is not authorized',()=>{
  const hint=githubIssueGuidance('Check GitHub issue #28',[
    'mcp_github_get_me','mcp_github_search_code','mcp_github_search_repositories'
  ]);
  assert.match(hint,/NOT available/);
  assert.match(hint,/do not invent its title or requirements/);
});
test('ordinary chat and non-GitHub questions get no unsolicited GitHub instructions',()=>{
  assert.equal(githubIssueGuidance('Hello, how are you?', ['mcp_github_issue_read']),'');
  assert.equal(githubIssueGuidance('Explain issue #29 in my team', ['mcp_github_issue_read']),'');
  assert.equal(githubIssueGuidance('Search GitHub repos for orchestration', ['mcp_github_issue_read']),'');
});
