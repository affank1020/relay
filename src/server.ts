import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { createRelayServer } from './application.js';

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session'];
const token = process.env.RELAY_ACCESS_TOKEN || '';
const modelId = process.env.RELAY_MODEL || 'poolside/laguna-s-2.1:free';
const maxActive = Number(process.env.RELAY_MAX_ACTIVE ?? 1);
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
let runtime: Promise<Awaited<ReturnType<typeof ModelRuntime.create>>> | undefined;

async function createPi(): Promise<PiSession> {
  runtime ??= ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15000 }).catch(error => {
    runtime = undefined;
    throw error;
  });
  const modelRuntime = await runtime;
  const model = modelRuntime.getModel('openrouter', modelId);
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
    modelRuntime, model, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(), noTools: 'all'
  });
  return session;
}

const { server, dispose } = createRelayServer({
  token, modelId, maxActive, createPi,
  staticDir: join(dirname(fileURLToPath(import.meta.url)), 'public')
});
server.listen(Number(process.env.PORT || 8765), process.env.HOST || '0.0.0.0', () => {
  const address = server.address();
  console.log('Relay started on port ' + (address && typeof address === 'object' ? address.port : 'unknown'));
});
process.on('SIGTERM', () => { server.close(); dispose(); });
