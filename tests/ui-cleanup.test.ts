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
 
test('long chat names truncate instead of widening the sidebar', () => {
  const css=source('public/style.css');
  assert.match(css,/aside \{[^}]*max-width:\s*242px[^}]*min-width:\s*0/s);
  assert.match(css,/#sessions \{[^}]*min-width:\s*0/s);
  assert.match(css,/\.session \{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(css,/\.session-title \{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css,/@media\(max-width:850px\)[\s\S]*?max-width:\s*220px/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*?max-width:\s*min\(290px, 88vw\)/);
});
