import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Check the *compiled production server* with the actual Pi dependency.
// A session is created without sending any external model request.
test('compiled Relay serves HTML and creates durable conversations', { timeout: 65000 }, async () => {
  const token = 'ci-relay-integration-token-12345678';
  const home = await mkdtemp(join(tmpdir(), 'relay-pi-test-'));
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: '0', HOST: '127.0.0.1',
      HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi'), RELAY_DATA_DIR: join(home,'data'),
      RELAY_MAX_ACTIVE: '1',
      RELAY_ACCESS_TOKEN: token,
      OPENROUTER_API_KEY: 'ci-test-key-not-valid-for-inference',
      RELAY_MODEL: 'cohere/north-mini-code:free',
      RELAY_OLLAMA_URL: 'http://127.0.0.1:11434/v1',
      RELAY_OLLAMA_MODELS: 'qwen3:4b',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('Relay started') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Relay exited before ready: ' + output);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.match(output, /Relay started/, 'Relay did not start: ' + output);
    const port = output.match(/Relay started on port (\d+)/)?.[1];
    assert.ok(port, 'Server must report its ephemeral port');
    const root = await fetch('http://127.0.0.1:' + port + '/');
    assert.equal(root.status, 200, 'Compiled server must serve HTML from dist/public');
    assert.match(await root.text(), /Relay · Agent control plane/);
    const client = await fetch('http://127.0.0.1:' + port + '/app.js');
    assert.equal(client.status, 200, 'Compiled browser entrypoint must exist');
    await client.text();
    const statusResponse = await fetch('http://127.0.0.1:' + port + '/api/status', {headers:{Authorization:'Bearer '+token}});
    assert.equal(statusResponse.status,200);
    const status=await statusResponse.json() as {models?:{key:string}[]};
    assert.deepEqual(status.models?.map(m=>m.key),['openrouter/cohere/north-mini-code:free','ollama/qwen3:4b']);
    const invalid = await fetch('http://127.0.0.1:' + port + '/api/sessions', {
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({modelKey:'ollama/not-allowed'})
    });
    assert.equal(invalid.status,400);
    const localSession=await fetch('http://127.0.0.1:' + port + '/api/sessions', {
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({modelKey:'ollama/qwen3:4b'})
    });
    assert.equal(localSession.status,201);
    const selected=await localSession.json() as {session:{modelKey?:string}};
    assert.equal(selected.session.modelKey,'ollama/qwen3:4b');
    const response = await fetch('http://127.0.0.1:' + port + '/api/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(45000)
    });
    const body = await response.text();
    assert.equal(response.status, 201, 'Pi session creation failed: ' + body + '\n' + output);
    const data = JSON.parse(body) as { session?: { id?: string } };
    assert.ok(data.session?.id);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await rm(home, { recursive: true, force: true });
  }
});
