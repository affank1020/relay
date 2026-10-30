import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createRelayServer, type RelayAgent, type RelayOptions } from '../src/application.js';

const token = 'relay-http-tests-token-123456789';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function agent(prompt: RelayAgent['prompt'] = async () => {}): RelayAgent {
  return { prompt, subscribe: () => () => {}, abort: async () => {},
    getLastAssistantText: () => 'Fixture answer', dispose: () => {} };
}
async function fixture(t: TestContext, overrides: Partial<RelayOptions> = {}) {
  const app = createRelayServer({ token, modelId: 'fixture:free', maxActive: 1,
    staticDir: new URL('../dist/public', import.meta.url).pathname,
    createPi: async () => agent(), ...overrides });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    app.dispose();
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
  const url = 'http://127.0.0.1:' + address.port;
  const api = (path: string, init: RequestInit = {}) => fetch(url + '/api/' + path, {
    ...init, headers: { Authorization: 'Bearer ' + token, ...init.headers },
    signal: AbortSignal.timeout(5000)
  });
  const session = async () => {
    const response = await api('sessions', { method: 'POST' });
    assert.equal(response.status, 201);
    return (await response.json() as { session: { id: string } }).session.id;
  };
  return { ...app, url, api, session };
}

test('HTTP authentication protects every API operation; static health stays public', async t => {
  let created = 0;
  const f = await fixture(t, { createPi: async () => { created++; return agent(); } });
  for (const [path, method] of [['status', 'GET'], ['sessions', 'GET'], ['sessions', 'POST'],
    ['sessions/abc/messages', 'POST'], ['sessions/abc/abort', 'POST']]) {
    for (const authorization of ['', 'Bearer wrong', token]) {
      const response = await fetch(f.url + '/api/' + path, { method, headers: { Authorization: authorization } });
      assert.equal(response.status, 401);
      await response.text();
    }
  }
  assert.equal(created, 0);
  const health = await fetch(f.url + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  await health.text();
  for (const path of ['/constructor', '/toString', '/__proto__']) {
    const response = await fetch(f.url + path);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test('invalid concurrency, weak token and paid model fail before listening', () => {
  const options: RelayOptions = { token, modelId: 'fixture:free', maxActive: 1, staticDir: '.', createPi: async () => agent() };
  for (const maxActive of [NaN, Infinity, 0, -1, 1.5, 5]) {
    assert.throws(() => createRelayServer({ ...options, maxActive }), /RELAY_MAX_ACTIVE/);
  }
  assert.throws(() => createRelayServer({ ...options, token: 'weak' }), /RELAY_ACCESS_TOKEN/);
  assert.throws(() => createRelayServer({ ...options, modelId: 'paid' }), /free-only/);
});

test('invalid bodies never start inference; successful stream and transcript agree', async t => {
  let prompts = 0;
  const f = await fixture(t, { createPi: async () => agent(async () => { prompts++; }) });
  const id = await f.session();
  for (const body of ['{', 'null', '{}', '{"message":""}', JSON.stringify({ message: 'x'.repeat(6001) })]) {
    const response = await f.api('sessions/' + id + '/messages', { method: 'POST', body });
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(prompts, 0);
  const response = await f.api('sessions/' + id + '/messages', { method: 'POST', body: '{"message":"hello"}' });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.type), ['start', 'done']);
  assert.equal(events[1].data.text, 'Fixture answer');
  const saved = await (await f.api('sessions/' + id)).json() as { turns: unknown[]; session: { busy: boolean } };
  assert.deepEqual(saved.turns, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'Fixture answer' }]);
  assert.equal(saved.session.busy, false);
  assert.equal(prompts, 1);
});

for (const sameSession of [true, false]) {
  test('a delayed request body cannot bypass ' + (sameSession ? 'session exclusion' : 'global concurrency'), async t => {
    const entered = deferred();
    const finish = deferred();
    t.after(() => finish.resolve());
    let prompts = 0;
    const f = await fixture(t, { createPi: async () => agent(async () => {
      prompts++; entered.resolve(); await finish.promise;
    }) });
    const firstId = await f.session();
    const secondId = sameSession ? firstId : await f.session();
    // Wait until the server has accepted the slow request's headers before starting the fast one.
    const received = once(f.server, 'request');
    const slowResult = deferred<{ status: number; body: string }>();
    const slow = request(f.url + '/api/sessions/' + secondId + '/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => slowResult.resolve({ status: response.statusCode!, body }));
    });
    slow.on('error', slowResult.reject);
    t.after(() => slow.destroy());
    slow.write('{"message":');
    await received;
    const fast = f.api('sessions/' + firstId + '/messages', { method: 'POST', body: '{"message":"fast"}' });
    await entered.promise;
    slow.end('"slow"}');
    const rejected = await slowResult.promise;
    assert.equal(rejected.status, sameSession ? 409 : 429);
    assert.equal(prompts, 1);
    finish.resolve();
    await (await fast).text();
    assert.equal((await (await f.api('status')).json() as { active: number }).active, 0);
  });
}

test('session cap includes pending Pi creation and releases failed reservations', async t => {
  const gate = deferred<RelayAgent>();
  let created = 0;
  const f = await fixture(t, { createPi: () => { created++; return gate.promise; } });
  const reached = deferred();
  f.server.on('request', () => { if (created === 30) reached.resolve(); });
  const pending = Array.from({ length: 30 }, () => f.api('sessions', { method: 'POST' }));
  await reached.promise;
  const denied = await f.api('sessions', { method: 'POST' });
  assert.equal(denied.status, 429);
  await denied.text();
  assert.equal(created, 30);
  gate.reject(new Error('Fixture initialization failed'));
  const responses = await Promise.all(pending);
  for (const response of responses) { assert.equal(response.status, 400); await response.text(); }
  const retried = await f.api('sessions', { method: 'POST' });
  assert.equal(retried.status, 400);
  await retried.text();
  assert.equal(created, 31);
});

for (const stage of ['subscribe', 'prompt', 'unsubscribe'] as const) {
  test(stage + ' failure releases the active slot', async t => {
    const broken = agent(async () => { throw new Error('Fixture prompt failed'); });
    if (stage === 'unsubscribe') broken.subscribe = () => () => { throw new Error('Fixture unsubscribe failed'); };
    if (stage === 'subscribe') broken.subscribe = () => { throw new Error('Fixture subscribe failed'); };
    const f = await fixture(t, { createPi: async () => broken });
    const id = await f.session();
    for (let i = 0; i < 2; i++) {
      const response = await f.api('sessions/' + id + '/messages', { method: 'POST', body: '{"message":"hello"}' });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /"type":"error"/);
      assert.equal((await (await f.api('status')).json() as { active: number }).active, 0);
    }
  });
}
