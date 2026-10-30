import type { CreateSessionResponse, SessionResponse, SessionsResponse, StatusResponse, StreamEvent, Turn } from './shared.js';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing Relay UI element: ' + id);
  return node as T;
}
let token = '';
let current: string | null = null;
let history: Turn[] = [];
let busy = false;
// HTTPS uses VPS Basic Auth, while local HTTP can use Relay's private token.
const hosted = window.location.protocol === 'https:';
const messages = $('messages');
function element(tag: string, className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
async function api(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (!hosted && token) headers.set('Authorization', 'Bearer ' + token);
  if (hosted) headers.delete('Authorization');
  const response = await fetch('/api' + path, { ...options, credentials: 'same-origin', headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || 'Request failed');
  }
  return response;
}
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
function bubble(role: Turn['role'], text: string): HTMLElement {
  const box = element('div', 'message ' + role, '');
  const heading = element('span', 'heading', role === 'user' ? 'You' : 'Relay');
  const body = element('div', 'text', text);
  box.append(heading, body);
  messages.append(box);
  messages.scrollTop = messages.scrollHeight;
  return body;
}
function render(): void {
  messages.replaceChildren();
  if (!history.length) {
    const empty = element('div', 'empty', '');
    empty.append(
      element('span', 'spark', '✳'),
      element('h2', '', 'A fresh conversation.'),
      element('p', '', 'Pi handles the reasoning loop. Relay manages sessions and the interface.')
    );
    messages.append(empty);
    return;
  }
  for (const turn of history) bubble(turn.role, turn.text);
}
function setBusy(value: boolean): void {
  busy = value;
  $<HTMLButtonElement>('new').disabled = value;
  $<HTMLButtonElement>('send').disabled = value;
  $<HTMLTextAreaElement>('prompt').disabled = value;
  $('stop').hidden = !value;
  $('state').textContent = value ? 'Thinking…' : 'Idle';
}
async function refresh(): Promise<void> {
  const [state, list] = await Promise.all([
    api('/status').then(json<StatusResponse>),
    api('/sessions').then(json<SessionsResponse>)
  ]);
  $('model').textContent = state.provider + ' · ' + state.model;
  $('connection').textContent = 'Pi connected';
  $('sessions').replaceChildren();
  for (const s of list.sessions) {
    const button = element('button', 'session' + (s.id === current ? ' selected' : ''), s.title) as HTMLButtonElement;
    button.type = 'button';
    button.onclick = () => { void select(s.id).catch(showError); };
    $('sessions').append(button);
  }
}
async function select(id: string): Promise<void> {
  if (busy) return;
  current = id;
  const data = await api('/sessions/' + id).then(json<SessionResponse>);
  history = data.turns;
  $('title').textContent = data.session.title;
  $('cost').textContent = 'Session $' + data.session.costUsd.toFixed(4);
  render();
  await refresh();
}
async function create(): Promise<void> {
  if (busy) return;
  const result = await api('/sessions', { method: 'POST', body: '{}' }).then(json<CreateSessionResponse>);
  await select(result.session.id);
  $<HTMLTextAreaElement>('prompt').focus();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function showError(error: unknown): void { window.alert(errorText(error)); }
function showHostedError(error: unknown, stage: 'api' | 'session' = 'api'): void {
  const failedSession = stage === 'session';
  $('connection').textContent = failedSession ? 'Session unavailable' : 'API unavailable';
  $('settings').hidden = false;
  $('settings').title = 'Retry connection';
  const prefix = failedSession ? 'Relay could not start a Pi session: ' : 'Relay API request failed: ';
  messages.replaceChildren(element('div', 'empty', prefix + errorText(error) + '. Retry the connection.'));
}
async function submit(event: Event): Promise<void> {
  event.preventDefault();
  if (busy) return;
  const prompt = $<HTMLTextAreaElement>('prompt');
  const value = prompt.value.trim();
  if (!value) return;
  if (!current) await create();
  prompt.value = '';
  history.push({ role: 'user', text: value });
  if (history.length === 1) $('title').textContent = value.slice(0, 55);
  render();
  const body = bubble('assistant', '');
  let answer = '';
  setBusy(true);
  try {
    const response = await api('/sessions/' + current + '/messages', { method: 'POST', body: JSON.stringify({ message: value }) });
    if (!response.body) throw new Error('Response stream unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as StreamEvent;
        if (e.type === 'delta') {
          answer += e.data.text;
          body.textContent = answer;
          messages.scrollTop = messages.scrollHeight;
        }
        if (e.type === 'done') {
          answer = e.data.text;
          body.textContent = answer;
          $('cost').textContent = 'Session $' + e.data.costUsd.toFixed(4);
        }
        if (e.type === 'error') throw new Error(e.data.message);
      }
    }
    history.push({ role: 'assistant', text: answer });
  } catch (error) {
    body.textContent = 'Error: ' + errorText(error);
    history.push({ role: 'assistant', text: body.textContent });
  } finally {
    setBusy(false);
    await refresh().catch(() => {});
    prompt.focus();
  }
}
$<HTMLFormElement>('loginForm').onsubmit = async (event) => {
  event.preventDefault();
  if (hosted) return;
  token = $<HTMLInputElement>('token').value;
  try {
    await api('/status');
    $<HTMLDialogElement>('login').close();
    $<HTMLInputElement>('token').value = '';
    $('error').textContent = '';
    await refresh();
    if (!current) await create();
  } catch (error) {
    $('error').textContent = errorText(error);
  }
};
$<HTMLButtonElement>('settings').onclick = () => {
  if (hosted) { void bootstrap(); return; }
  token = '';
  $<HTMLDialogElement>('login').showModal();
};
$<HTMLButtonElement>('new').onclick = () => { void create().catch(showError); };
$<HTMLFormElement>('form').onsubmit = (event) => { void submit(event); };
$<HTMLButtonElement>('stop').onclick = () => {
  if (current && busy) void api('/sessions/' + current + '/abort', { method: 'POST', body: '{}' }).catch(showError);
};
$<HTMLTextAreaElement>('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $<HTMLFormElement>('form').requestSubmit();
  }
};
async function bootstrap(): Promise<void> {
  let stage: 'api' | 'session' = 'api';
  try {
    await api('/status');
    $('settings').hidden = hosted;
    await refresh();
    stage = 'session';
    if (!current) await create();
  } catch (error) {
    if (hosted) showHostedError(error, stage);
    else $<HTMLDialogElement>('login').showModal();
  }
}
void bootstrap();
