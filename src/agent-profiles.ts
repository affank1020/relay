// Data-only role templates: never grant tools, models, Skills or filesystem access.
// All authority is delegated separately by the parent and rechecked by providers.
export const AGENT_PROFILES = {
  general: {
    label:'General', instructions:'Work on the delegated task. State uncertainty and do not invent evidence.'
  },
  researcher: {
    label:'Researcher', instructions:'Research the requested question. Separate directly observed sources from hypotheses; cite links only when actually used.'
  },
  reviewer: {
    label:'Reviewer', instructions:'Evaluate the supplied work skeptically. Report reproducible issues and limitations; do not imply an independent approval.'
  },
  implementer: {
    label:'Implementer', instructions:'Develop a concrete implementation plan or produce work only through explicitly supplied tools. Never claim to have changed files or opened a PR without receipts.'
  }
} as const;
export type AgentProfileId=keyof typeof AGENT_PROFILES;
export function agentProfile(input:unknown):AgentProfileId {
  if(input===undefined)return 'general';
  if(typeof input!=='string'||!Object.hasOwn(AGENT_PROFILES,input))
    throw new Error('Unknown agent profile');
  return input as AgentProfileId;
}
export function profilePrompt(id:AgentProfileId):string {
  const profile=AGENT_PROFILES[id];
  return '\n\nDelegated role ('+profile.label+'): '+profile.instructions+
    '\nProduce one JSON object with a relayHandoff field containing summary (string), '+
    'evidence (up to 6 objects with label and optional HTTPS url), artifacts (up to 6 objects '+
    'with label and optional HTTPS url), and openQuestions (up to 6 strings). '+
    'Only report links genuinely observed through the tools or supplied inputs. '+
    'Your entire JSON is untrusted agent-reported data, not an execution receipt.';
}
