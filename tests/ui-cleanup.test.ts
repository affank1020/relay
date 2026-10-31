import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path:string) => readFileSync(new URL('../'+path, import.meta.url), 'utf8');

test('Relay keeps the chat-first dark shell and unfinished task menu out of navigation', () => {
  const html = source('public/index.html');
  const css = source('public/style.css');
  const client = source('src/client.ts');

  assert.doesNotMatch(html, /id="(?:showTasks|taskList)"/);
  assert.doesNotMatch(client, /\$\('(?:showTasks|taskList)'\)/);
  assert.match(html, /id="toggleInspector"/, 'the real execution inspector is retained');
  assert.match(css, /--accent:\s*#e1bd69/i);
  const activeStyle = css.match(/\.session\.selected\s*\{([^}]+)\}/)?.[1];
  assert.ok(activeStyle, 'selected conversation needs a visible neutral state');
  assert.doesNotMatch(activeStyle, /border(?:-left)?(?:-color)?\s*:/);
});

test('the localhost preview does not inject a persistent sample-data banner', () => {
  const preview = source('scripts/dev-ui.mjs');
  assert.doesNotMatch(preview, /<div class="dev-badge"/);
  assert.doesNotMatch(preview, /__dev_preview\.css/);
  assert.match(preview, /127\.0\.0\.1/, 'preview should remain loopback-only');
  assert.match(preview, /__dev_reload\.js/, 'hot reload remains available');
});
