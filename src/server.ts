import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { SessionSummary, Turn, StreamEvent } from './shared.js';

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session'];
interface RelaySession extends SessionSummary {
  pi: PiSession;
  turns: Turn[];
}
const token = process.env.RELAY_ACCESS_TOKEN || '';
const modelId = process.env.RELAY_MODEL || 'poolside/laguna-s-2.1:free';
// Keep the existing zero-cost model safeguard.
if (!modelId.endsWith(':free')) throw new Error('Relay free-only mode requires RELAY_MODEL to end in :free');
const maxActive = Math.max(1, Math.min(4, Number(process.env.RELAY_MAX_ACTIVE || 1)));
if (token.length < 24) throw new Error('RELAY_ACCESS_TOKEN must be 24+ characters');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');

// The build emits dist/server.js and dist/public/{index.html,app.js,style.css}.
const staticDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const files: Record<string, readonly [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'application/javascript'],
  '/style.css': ['style.css', 'text/css']
};
const sessions = new Map<string, RelaySession>();
let active = 0;
let runtime: Awaited<ReturnType<typeof ModelRuntime.create>> | undefined;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function send(res: ServerResponse, code: number, value: object): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function allowed(req: IncomingMessage): boolean {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
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

async function createPi(): Promise<PiSession> {
  runtime ||= await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15000 });
  const model = runtime.getModel('openrouter', modelId);
  if (!model) throw new Error('Model unavailable in Pi OpenRouter catalog: ' + modelId);
  // Pi SDK requires both paths. /tmp is the only writable directory in Docker.
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || '/tmp', '.pi');
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    systemPromptOverride: () => 'You are Relay, a concise and helpful AI assistant. No tools are enabled in this initial release. Never claim to have read files, used Atlas, or executed operations.'
  });
  await loader.reload();
  const { session } = await createAgentSession({
    modelRuntime: runtime, model, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(), noTools: 'all'
  });
  return session;
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self';script-src 'self';style-src 'self';connect-src 'self';frame-ancestors 'none';base-uri 'none'");
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'relay' });
  const asset = files[path];
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
      if (sessions.size >= 30) return send(res, 429, { error: 'Session limit reached' });
      const pi = await createPi();
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

    s.turns.push({ role: 'user', text: prompt });
    if (s.title === 'New conversation') s.title = prompt.slice(0, 55);
    s.busy = true;
    active++;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    event(res, { type: 'start', data: summary(s) });
    const unsubscribe = s.pi.subscribe((e) => {
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
    try {
      await s.pi.prompt(prompt);
      const answer = s.pi.getLastAssistantText() || '';
      s.turns.push({ role: 'assistant', text: answer });
      event(res, { type: 'done', data: { text: answer, costUsd: s.costUsd } });
    } catch (error) {
      event(res, { type: 'error', data: { message: message(error).slice(0, 240) } });
    } finally {
      unsubscribe();
      s.busy = false;
      active--;
      if (!res.destroyed) res.end();
    }
  } catch (error) {
    console.error('Relay request failed:', error instanceof Error ? error.stack : String(error));
    if (!res.headersSent) send(res, 400, { error: message(error).slice(0, 240) });
    else res.end();
  }
});
server.listen(Number(process.env.PORT || 8765), process.env.HOST || '0.0.0.0', () => console.log('Relay started'));
process.on('SIGTERM', () => {
  server.close();
  for (const s of sessions.values()) void s.pi.dispose();
});
