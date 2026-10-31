import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

// Execute the browser's generated bundle, not uncompiled TypeScript.
const source = readFileSync(new URL('../dist/public/app.js', import.meta.url), 'utf8');
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

interface MockElement {
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  title: string;
  shown?: number;
  closed?: boolean;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  showModal(): void;
  close(): void;
  focus(): void;
  setAttribute(name:string,value:string):void;
  append(...items: unknown[]): void;
  replaceChildren(...items: unknown[]): void;
}

function harness(
  hostname: string, protocol: string,
  responder: (url: string, options: RequestInit) => Response
) {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const nodes = new Map<string, MockElement>();
  const element = (id: string): MockElement => {
    let found = nodes.get(id);
    if (!found) {
      found = {
        textContent: '', value: '', hidden: false, disabled: false, title: '',
        showModal() { this.shown = (this.shown || 0) + 1; },
        close() { this.closed = true; },
        focus() {}, setAttribute() {}, append() {}, replaceChildren() {},
      };
      nodes.set(id, found);
    }
    return found;
  };
  const context = {
    window: { location: { hostname, protocol }, alert() {} },
    document: {
      getElementById: element,
      createElement: () => ({ textContent: '', className: '', append() {}, focus() {}, setAttribute() {}, replaceChildren() {} })
    },
    Headers,
    TextDecoder,
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return responder(url, options);
    }
  };
  runInNewContext(source, context, { filename: 'dist/public/app.js' });
  return { requests, element };
}
const fail = (error: string, status: number): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('hosted HTTPS uses Basic Auth and never asks for an API token', async () => {
  const { requests, element } = harness('relay.affankhan.dev', 'https:', url => {
    if (url === '/api/status') return ok({ provider: 'OpenRouter', model: 'test-free' });
    if (url === '/api/sessions') return ok({ sessions: [] });
    return fail('Mock session creation unavailable', 503);
  });
  await flush(); await flush(); await flush();
  assert.ok(requests.length > 0);
  assert.ok(requests.every(r => (r.options.headers as Headers).get('Authorization') === null));
  assert.ok(requests.every(r => r.options.credentials === 'same-origin'));
  assert.equal(element('login').shown || 0, 0);
});

test('hosted gateway errors show retry rather than prompting for token', async () => {
  const { requests, element } = harness('relay.affankhan.dev', 'https:', () => fail('Gateway unavailable', 502));
  await flush(); await flush();
  assert.equal(requests.length, 1);
  assert.equal((requests[0].options.headers as Headers).get('Authorization'), null);
  assert.equal(element('login').shown || 0, 0);
  assert.equal(element('connection').textContent, 'API unavailable');
  assert.equal(element('settings').title, 'Retry connection');
});

test('direct localhost HTTP retains the internal Bearer token', async () => {
  let authenticated = false;
  const { requests, element } = harness('127.0.0.1', 'http:', (url, options) => {
    const authorization = (options.headers as Headers).get('Authorization');
    if (url === '/api/status' && !authorization) return fail('Invalid Relay token', 401);
    if (url === '/api/status' && authorization === 'Bearer local-test-token') {
      authenticated = true;
      return ok({ provider: 'OpenRouter', model: 'test-free' });
    }
    if (url === '/api/sessions') return ok({ sessions: [] });
    return fail('Mock session creation unavailable', 503);
  });
  await flush(); await flush();
  assert.equal(element('login').shown, 1);
  element('token').value = 'local-test-token';
  await element('loginForm').onsubmit?.({ preventDefault() {} });
  assert.equal(authenticated, true);
  assert.ok(requests.some(r => (r.options.headers as Headers).get('Authorization') === 'Bearer local-test-token'));
});
