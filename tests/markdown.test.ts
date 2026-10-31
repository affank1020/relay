import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineTokens, markdownBlocks, renderMarkdown } from '../src/markdown.js';

test('Markdown blocks parse headings, lists, fenced code and paragraphs',()=>{
  const fence=String.fromCharCode(96).repeat(3);
  const blocks=markdownBlocks('# Report\n\n**Ready** today.\n\n- Alpha\n- Beta\n\n'+fence+'ts\nconst a = 1;\n'+fence);
  assert.deepEqual(blocks.map(x=>x.type),['heading','paragraph','list','code']);
  assert.deepEqual(blocks[2].items,['Alpha','Beta']);
  assert.equal(blocks[3].lang,'ts');
  assert.equal(blocks[3].text,'const a = 1;');
});

test('untrusted markup remains text and only explicit http(s) links are clickable',()=>{
  const tick=String.fromCharCode(96);
  const tokens=inlineTokens('**bold** and '+tick+'inline'+tick+' [Atlas](https://atlas.affankhan.dev) <img src=x onerror=alert(1)> [bad](javascript:alert(1))');
  assert.ok(tokens.some(x=>x.type==='strong'&&x.text==='bold'));
  assert.ok(tokens.some(x=>x.type==='code'&&x.text==='inline'));
  assert.ok(tokens.some(x=>x.type==='link'&&x.href==='https://atlas.affankhan.dev/'));
  assert.ok(!tokens.some(x=>x.href?.startsWith('javascript:')));
  assert.ok(tokens.some(x=>x.type==='text'&&x.text.includes('<img')));
});

test('HTML-free renderer creates elements via textContent without injecting model HTML',()=>{
  class Node {
    textContent='';className='';href='';target='';rel='';type='';onclick?:()=>void;
    readonly children:Node[]=[];
    constructor(readonly tag:string){}
    append(...children:Node[]){this.children.push(...children);}
    setAttribute() {}
  }
  const before=globalThis.document;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Node(tag)}});
  try{
    const markup=renderMarkdown('<script>alert(1)</script>\n\n[Open Atlas](https://atlas.affankhan.dev)') as unknown as Node;
    assert.equal(markup.children[0].tag,'p');
    assert.equal(markup.children[0].children[0].textContent,'<script>alert(1)</script>');
    assert.equal(markup.children[1].children[0].tag,'a');
    assert.equal(markup.children[1].children[0].rel,'noopener noreferrer');
  }finally{Object.defineProperty(globalThis,'document',{configurable:true,value:before});}
});

test('Markdown links preserve balanced nested and escaped URL parentheses',()=>{
  const source='[Function](https://en.wikipedia.org/wiki/Function_(mathematics)) '+
    '[nested](https://example.com/outer(inner(deeper))) '+
    '[escaped](https://example.com/a\\(b\\))';
  const links=inlineTokens(source).filter(token=>token.type==='link');
  assert.deepEqual(links.map(link=>link.text),['Function','nested','escaped']);
  assert.deepEqual(links.map(link=>link.href),[
    'https://en.wikipedia.org/wiki/Function_(mathematics)',
    'https://example.com/outer(inner(deeper))',
    'https://example.com/a(b)'
  ]);
  assert.ok(!inlineTokens(source).some(token=>token.type==='text'&&token.text.includes(') ')),
    'no orphan closing parenthesis should remain after a valid link');
});

test('Malformed or unsafe link destinations never become anchors',()=>{
  const source='[no](javascript:alert(1)) [space](https://example.com/a b) [open](https://example.com/path(a)';
  const links=inlineTokens(source).filter(token=>token.type==='link');
  assert.equal(links.length,0);
  assert.ok(inlineTokens('[valid](https://example.com/a(b)) tail').some(token=>token.type==='text'&&token.text===' tail'));
});
