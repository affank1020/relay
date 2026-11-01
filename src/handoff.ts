// Historical display shape only; new Pi children return native tool results.
export interface HandoffReference { label:string; url?:string }
export interface AgentHandoff {
  schemaVersion:1;
  provenance:'agent_reported';
  structured:boolean;
  summary:string;
  evidence:HandoffReference[];
  artifacts:HandoffReference[];
  openQuestions:string[];
}
