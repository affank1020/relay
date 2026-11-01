// Provider-neutral Pi sessions intentionally have no implicit tools. This
// guidance only helps Pi select an already-authorized GitHub MCP tool; it
// never grants one or treats tool availability as evidence of a successful read.
const numberedIssue=/\bissues?\s*(?:number\s*)?#?\s*\d+\b/i;
const githubRequest=/\bgithub\b|\bmcp_github_/i;
export function githubIssueGuidance(prompt:string,toolNames:readonly string[]):string {
  if(!numberedIssue.test(prompt)||!githubRequest.test(prompt))return '';
  if(!toolNames.includes('mcp_github_issue_read'))
    return '\nGitHub issue evidence constraint: The direct GitHub issue_read tool is NOT available in this run. Do not substitute get_me, search_code or search_repositories for the requested issue body. State that the exact issue could not be retrieved; do not invent its title or requirements.';
  return '\nGitHub issue evidence constraint: For an exact numbered GitHub issue, call mcp_github_issue_read with method=get, owner, repo and issue_number. Follow the supplied tool schema. This is the primary way to retrieve its actual title, body and requirements. get_me, search_code, and search_repositories do NOT provide the issue body and are not substitutes. Only summarize the issue after the issue_read response succeeds; if it fails, say so and do not infer the issue content from general search results.';
}
