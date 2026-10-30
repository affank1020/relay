export interface SessionSummary {
  id: string;
  title: string;
  costUsd: number;
  busy: boolean;
  createdAt: string;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface StatusResponse {
  harness: string;
  provider: string;
  model: string;
  active: number;
  maxActive: number;
  atlas: string;
}

export interface SessionsResponse { sessions: SessionSummary[] }
export interface SessionResponse { session: SessionSummary; turns: Turn[] }
export interface CreateSessionResponse { session: SessionSummary }

export type StreamEvent =
  | { type: 'start'; data: SessionSummary }
  | { type: 'delta'; data: { text: string } }
  | { type: 'done'; data: { text: string; costUsd: number } }
  | { type: 'error'; data: { message: string } }
  | { type: 'tool'; data: { name: string; status: string } };
