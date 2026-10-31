// Stable, provider-neutral contract for orchestration and Atlas observation.
// Execution records must never carry arguments, credentials, or raw tool results.
export type ToolInvocationState = 'validating'|'denied'|'started'|'completed'|'failed'|'cancelled';
export interface ToolInvocationEnvelopeV1 {
  schemaVersion:1;
  providerId:string;
  toolName:string;
  taskId:string;
  agentRunId?:string;
  invocationId:string;
  state:ToolInvocationState;
  timestamp:string;
  safeResultRef?:string;
}
export const toolDisplayName=(provider:string,name:string):string =>
  (provider+':'+name).replace(/[^a-zA-Z0-9:_-]/g,'').slice(0,110);
