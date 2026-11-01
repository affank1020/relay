import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

// Let Pi's native tool_search handle tool selection. Only tools that Relay
// already admitted can enter this registry; discovery never grants authority.
export function piToolLoadout(tools:readonly ToolDefinition[]) {
  const deferred=tools.filter(tool=>/^(?:atlas_|mcp_)/.test(tool.name));
  const customTools=tools.map(tool=>deferred.includes(tool)
    ?{...tool,exposure:'deferred' as const}:tool);
  return {
    customTools,
    activeNames:[
      ...tools.filter(tool=>!deferred.includes(tool)).map(tool=>tool.name),
      ...(deferred.length?['tool_search']:[])
    ],
    allowedNames:new Set([...tools.map(tool=>tool.name),...(deferred.length?['tool_search']:[])]),
    deferredNames:deferred.map(tool=>tool.name)
  };
}

// Pi discovers SKILL.md metadata using its native ResourceLoader. Relay
// exposes only a bounded, previously validated snapshot of each Skill's text.
export function piSkillSummary(skills:readonly {name:string;description:string}[]):string {
  return skills.length
    ?'\nAvailable Skills (trusted, enabled; instructions are loaded only on request). Use read_skill with the exact name before following a Skill:\n'+
       skills.map(skill=>'- '+skill.name+': '+skill.description).join('\n')
    :'';
}
