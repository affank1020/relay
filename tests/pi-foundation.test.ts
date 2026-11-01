import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { piSkillSummary, piToolLoadout } from '../src/pi-foundation.js';

function tool(name:string):ToolDefinition {
  return {name,label:name,description:'Mock '+name,parameters:Type.Object({}),
    execute:async()=>({content:[{type:'text' as const,text:'ok'}],details:{}})};
}

test('Pi tool_search defers only already-admitted Atlas and MCP tools',()=>{
  const layout=piToolLoadout([
    tool('relay_delegate'),tool('mcp_github_issue_read'),
    tool('mcp_github_get_file_contents'),tool('atlas_list_nodes')
  ]);
  assert.deepEqual(layout.deferredNames,['mcp_github_issue_read','mcp_github_get_file_contents','atlas_list_nodes']);
  assert.deepEqual(layout.activeNames,['relay_delegate','tool_search']);
  assert.deepEqual(layout.customTools.map(t=>t.exposure),[undefined,'deferred','deferred','deferred']);
  assert.ok(!layout.activeNames.includes('mcp_github_issue_read'));
  assert.ok(!layout.allowedNames.has('bash'));
});

test('No external tools means no unneeded Pi tool discovery capability',()=>{
  const layout=piToolLoadout([tool('relay_delegate')]);
  assert.deepEqual(layout.activeNames,['relay_delegate']);
  assert.deepEqual(layout.deferredNames,[]);
  assert.ok(!layout.allowedNames.has('tool_search'));
});

test('Pi skill manifest advertises metadata, not full instructions',()=>{
  const result=piSkillSummary([{name:'prepare-pr',description:'Review current diff'}]);
  assert.match(result,/prepare-pr: Review current diff/);
  assert.match(result,/read_skill/);
  assert.ok(!result.includes('<trusted_skill'));
  assert.equal(piSkillSummary([]),'');
});
