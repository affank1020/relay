import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { createAgentSession } from '@earendil-works/pi-coding-agent';
import type { SessionSummary, Turn, StreamEvent } from './shared.js';

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session'];
export type RelayAgent = Pick<PiSession, 'prompt' | 'subscribe' | 'abort' | 'getLastAssistantText' | 'dispose'>;
interface RelaySession extends SessionSummary {
  pi: RelayAgent;
  turns: Turn[];
}
export interface RelayOptions {
  token: string;
  modelId: string;
  maxActive: number;
  staticDir: string;
  createPi: () => Promise<RelayAgent>;
}

export function createRelayServer({ token, modelId, maxActive, staticDir, createPi }: RelayOptions) {
  if (token.length < 24) throw new Error('RELAY_ACCESS_TOKEN must be 24+ characters');
  if (!modelId.endsWith(':free')) throw new Error('Relay free-only mode requires RELAY_MODEL to end in :free');
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 4) {
    throw new Error('RELAY_MAX_ACTIVE must be an integer from 1 to 4');
  }
  const files: Record<string, readonly [string, string]> = {
    '/': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'application/javascript'],
    '/style.css': ['style.css', 'text/css']
  };
  const sessions = new Map<string, RelaySession>();
  let active = 0;
  let creating = 0;

  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function send(res: ServerResponse, code: number, value: object): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  function allowed(req: IncomingMessage): boolean {
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    const got = Buffer.from(req.headers.authorization.slice(7));
    const expected = Buffer.from(token);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
  async function readBody(req: IncomingMessage): Promise<unknown> {
    let text = '';
    for await (const chunk of req) {
      text += chunk.toString('utf8');
      if (text.length > 12000) throw new Error('Request too large');
    }
    return JSON.parse(text || '{}') as unknown;
  }
  const summary = (s: RelaySession): SessionSummary => ({
    id: s.id, title: s.title, costUsd: s.costUsd, busy: s.busy, createdAt: s.createdAt
  });
  function event(res: ServerResponse, value: StreamEvent): void {
    if (!res.destroyed) res.write(JSON.stringify(value) + '\n');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self';script-src 'self';style-src 'self';connect-src 'self';frame-ancestors 'none';base-uri 'none'");
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'relay' });
    const asset = Object.hasOwn(files, path) ? files[path] : undefined;
    if (req.method === 'GET' && asset) {
      const [file, type] = asset;
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return createReadStream(join(staticDir, file)).pipe(res);
    }
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (!allowed(req)) return send(res, 401, { error: 'Invalid Relay token' });

    try {
      if (req.method === 'GET' && path === '/api/status') {
        return send(res, 200, { harness: 'Pi', provider: 'OpenRouter', model: modelId, active, maxActive, atlas: 'not connected' });
      }
      if (req.method === 'GET' && path === '/api/sessions') {
        return send(res, 200, { sessions: [...sessions.values()].map(summary).reverse() });
      }
      if (req.method === 'POST' && path === '/api/sessions') {
        if (sessions.size + creating >= 30) return send(res, 429, { error: 'Session limit reached' });
        // Reserve before awaiting Pi startup; failed creation releases the slot.
        creating++;
        let pi: RelayAgent;
        try { pi = await createPi(); } finally { creating--; }
        const s: RelaySession = {
          id: randomUUID(), pi, title: 'New conversation', turns: [],
          costUsd: 0, busy: false, createdAt: new Date().toISOString()
        };
        sessions.set(s.id, s);
        return send(res, 201, { session: summary(s) });
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/messages|\/abort)?$/);
      if (!match) return send(res, 404, { error: 'Unknown API route' });
      const s = sessions.get(match[1]);
      if (!s) return send(res, 404, { error: 'Session not found' });
      if (req.method === 'GET' && !match[2]) return send(res, 200, { session: summary(s), turns: s.turns });
      if (req.method === 'POST' && match[2] === '/abort') {
        if (s.busy) await s.pi.abort();
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'POST' || match[2] !== '/messages') return send(res, 405, { error: 'Method not allowed' });
      if (s.busy) return send(res, 409, { error: 'Session already running' });
      if (active >= maxActive) return send(res, 429, { error: 'All agent slots are busy' });
      const data = await readBody(req);
      const prompt = data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message.trim() : '';
      if (!prompt || prompt.length > 6000) return send(res, 400, { error: 'Message length must be 1–6000' });

      // Body reads yield to other requests. Check again immediately before admission.
      if (s.busy) return send(res, 409, { error: 'Session already running' });
      if (active >= maxActive) return send(res, 429, { error: 'All agent slots are busy' });
      s.turns.push({ role: 'user', text: prompt });
      if (s.title === 'New conversation') s.title = prompt.slice(0, 55);
      s.busy = true;
      active++;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      event(res, { type: 'start', data: summary(s) });
      let unsubscribe = () => {};
      try {
        unsubscribe = s.pi.subscribe((e) => {
          if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
            event(res, { type: 'delta', data: { text: e.assistantMessageEvent.delta } });
          }
          if (e.type === 'message_end' && e.message?.role === 'assistant') {
            const cost = Number(e.message.usage?.cost?.total || 0);
            if (Number.isFinite(cost) && cost >= 0) s.costUsd += cost;
          }
          if (e.type === 'tool_execution_start') event(res, { type: 'tool', data: { name: e.toolName, status: 'started' } });
          if (e.type === 'tool_execution_end') event(res, { type: 'tool', data: { name: e.toolName, status: e.isError ? 'failed' : 'completed' } });
        });
        await s.pi.prompt(prompt);
        const answer = s.pi.getLastAssistantText() || '';
        s.turns.push({ role: 'assistant', text: answer });
        event(res, { type: 'done', data: { text: answer, costUsd: s.costUsd } });
      } catch (error) {
        event(res, { type: 'error', data: { message: message(error).slice(0, 240) } });
      } finally {
        try { unsubscribe(); } finally {
          s.busy = false;
          active--;
          if (!res.destroyed) res.end();
        }
      }
    } catch (error) {
      console.error('Relay request failed:', error instanceof Error ? error.stack : String(error));
      if (!res.headersSent) send(res, 400, { error: message(error).slice(0, 240) });
      else res.end();
    }
  });
  return { server, dispose: () => { for (const s of sessions.values()) void s.pi.dispose(); } };
}
