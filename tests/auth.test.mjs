import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(hostname,protocol,responder){
  const requests=[],nodes=new Map();
  const element=id=>{
    if(!nodes.has(id)) nodes.set(id,{
      textContent:'',value:'',hidden:false,disabled:false,title:'',
      showModal(){this.shown=(this.shown||0)+1;},
      close(){this.closed=true;},focus(){},append(){},replaceChildren(){}
    });
    return nodes.get(id);
  };
  const context={
    window:{location:{hostname,protocol},alert(){}},
    document:{getElementById:element,createElement:()=>({textContent:'',append(){},focus(){}})},
    fetch:async(url,options)=>{requests.push({url,options});return responder(url,options);},
    TextDecoder
  };
  runInNewContext(source,context,{filename:'public/app.js'});
  return {requests,element};
}
const fail=(error,status)=>({ok:false,status,json:async()=>({error})});
const ok=data=>({ok:true,json:async()=>data});
test('hosted HTTPS never sets Bearer Authorization and never asks for an API token',async()=>{
  const {requests,element}=harness('relay.affankhan.dev','https:',url=>{
    if(url==='/api/status')return ok({provider:'OpenRouter',model:'test-free'});
    if(url==='/api/sessions')return ok({sessions:[]});
    return fail('No further mock sessions',503);
  });
  await flush();await flush();
  assert.ok(requests.length>0);
  assert.ok(requests.every(r=>r.options.headers.Authorization===undefined));
  assert.ok(requests.every(r=>r.options.credentials==='same-origin'));
  assert.equal(element('login').shown||0,0);
});
test('hosted gateway error is retryable rather than prompting for Bearer token',async()=>{
  const {requests,element}=harness('relay.affankhan.dev','https:',()=>fail('Gateway unavailable',502));
  await flush();await flush();
  assert.equal(requests.length,1);
  assert.equal(requests[0].options.headers.Authorization,undefined);
  assert.equal(element('login').shown||0,0);
  assert.equal(element('connection').textContent,'Gateway unavailable');
  assert.equal(element('settings').title,'Retry connection');
});
test('local HTTP still uses explicit API Bearer token',async()=>{
  let authenticated=false;
  const {requests,element}=harness('127.0.0.1','http:',(url,options)=>{
    if(url==='/api/status'&&!options.headers.Authorization)return fail('Invalid Relay token',401);
    if(url==='/api/status'&&options.headers.Authorization==='Bearer local-test-token'){
      authenticated=true;return ok({provider:'OpenRouter',model:'test-free'});
    }
    if(url==='/api/sessions')return ok({sessions:[]});
    return fail('No further mock sessions',503);
  });
  await flush();await flush();
  assert.equal(element('login').shown,1);
  element('token').value='local-test-token';
  await element('loginForm').onsubmit({preventDefault(){}});
  assert.ok(authenticated);
  assert.ok(requests.some(r=>r.options.headers.Authorization==='Bearer local-test-token'));
});
