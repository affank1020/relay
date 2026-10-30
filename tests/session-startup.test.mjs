import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

// Integration smoke test of the actual Pi SDK against Relay's HTTP API, with
// dummy auth. It creates a session but NEVER prompts an external language model.
// The suite must fail if the browser would receive a session-initialisation 400.
test('a valid API client can create a Pi session after startup', { timeout: 65000 }, async () => {
  const token='ci-relay-integration-token-12345678';
  const port=29876;
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:new URL('..',import.meta.url).pathname,
    env:{
      ...process.env,
      PORT:String(port),
      HOST:'127.0.0.1',
      HOME:'/tmp',
      PI_CODING_AGENT_DIR:'/tmp/.pi-relay-test',
      RELAY_ACCESS_TOKEN:token,
      OPENROUTER_API_KEY:'ci-test-key-not-valid-for-inference',
      RELAY_MODEL:'poolside/laguna-s-2.1:free',
    },
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{output+=chunk;});
  try{
    const deadline=Date.now()+15000;
    while(!output.includes('Relay started') && Date.now()<deadline){
      if(child.exitCode!==null)throw new Error('Relay exited before ready: '+output);
      await new Promise(r=>setTimeout(r,150));
    }
    assert.match(output,/Relay started/,'Relay failed to start: '+output);
    const res=await fetch('http://127.0.0.1:'+port+'/api/sessions',{
      method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:'{}',
      signal:AbortSignal.timeout(45000),
    });
    const body=await res.text();
    assert.equal(res.status,201,'Pi session bootstrap returned '+res.status+': '+body+'\nServer diagnostics:\n'+output);
    const parsed=JSON.parse(body);
    assert.ok(parsed.session?.id);
  }finally{
    child.kill('SIGTERM');
    if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]);
  }
});
