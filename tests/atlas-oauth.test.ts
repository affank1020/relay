import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AtlasClientCredentials, McpTransport } from '../src/gateway.js';

const issuer='https://example.us.auth0.com/';
const audience='https://atlas.affankhan.dev/mcp';
const accessToken='mock-atlas-service-access-token-not-for-production';

test('Atlas service credentials request least-privilege audience and deduplicate token refresh', async () => {
  let requests=0;
  const provider=new AtlasClientCredentials(issuer,'relay-client-id','private-client-secret',audience,
    async(input,init)=>{
      requests++;
      assert.equal(String(input),issuer+'oauth/token');
      assert.equal(init?.method,'POST');
      assert.equal(init?.redirect,'error');
      const body=new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'),'client_credentials');
      assert.equal(body.get('scope'),'atlas:relay:read');
      assert.equal(body.get('audience'),audience);
      assert.equal(body.get('client_id'),'relay-client-id');
      assert.equal(body.get('client_secret'),'private-client-secret');
      return new Response(JSON.stringify({access_token:accessToken,token_type:'Bearer',expires_in:3600,scope:'atlas:relay:read'}));
    });
  const values=await Promise.all(Array.from({length:10},()=>provider.token()));
  assert.deepEqual(new Set(values),new Set([accessToken]));
  assert.equal(requests,1);
  await provider.token();
  assert.equal(requests,1);
  provider.invalidate();
  await provider.token();
  assert.equal(requests,2);
});

test('Invalid or denied OAuth responses fail without logging a client secret', async () => {
  for(const status of [401,503]){
    const provider=new AtlasClientCredentials(issuer,'relay-client-id','secret-do-not-print',audience,
      async()=>new Response(JSON.stringify({error:'secret-do-not-print'}),{status}));
    await assert.rejects(provider.token(),error=>{
      assert.doesNotMatch(String(error),/secret-do-not-print/);return true;
    });
  }
  const provider=new AtlasClientCredentials(issuer,'relay-client-id','secret-do-not-print',audience,
    async()=>new Response(JSON.stringify({access_token:'bad',token_type:'Bearer',expires_in:3600})));
  await assert.rejects(provider.token(),/Invalid Atlas OAuth token response/);
  assert.throws(()=>new AtlasClientCredentials('http://insecure.invalid/','id','secret',audience),/Invalid Atlas OAuth/);
});

test('Atlas MCP sends refreshed M2M access tokens on real HTTP transport requests', async t=>{
  let usedToken=0,seen=0;
  const http=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+accessToken){res.writeHead(401);res.end();return;}
    seen++;
    const mcp=new McpServer({name:'atlas-m2m-fixture',version:'1'});
    mcp.registerTool('get_atlas_status',{description:'Atlas fixture',inputSchema:{}},
      async()=>({content:[{type:'text',text:'available'}],structuredContent:{result:{available:true}}}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.once('close',()=>{void mcp.close()});
    await mcp.connect(transport);await transport.handleRequest(req,res);
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const a=http.address();assert.ok(a&&typeof a==='object');
  const provider=new AtlasClientCredentials(issuer,'relay-client-id','secret',audience,async()=>{
    usedToken++;
    return new Response(JSON.stringify({access_token:accessToken,token_type:'Bearer',expires_in:3600,scope:'atlas:relay:read'}));
  });
  const mcp=new McpTransport('http://127.0.0.1:'+a.port+'/mcp',provider);
  t.after(async()=>{await mcp.close();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));});
  const tools=await mcp.list();
  assert.deepEqual(tools.map(t=>t.name),['get_atlas_status']);
  const result=await mcp.call('get_atlas_status',{});
  assert.equal((result as unknown as {structuredContent:{result:{available:boolean}}}).structuredContent.result.available,true);
  assert.ok(seen>=2);
  assert.equal(usedToken,1);
});
