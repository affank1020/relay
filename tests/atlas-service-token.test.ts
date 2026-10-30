import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpTransport } from '../src/gateway.js';

const token = 'a'.repeat(64);

test('Relay MCP client attaches the dedicated service bearer token over HTTP', async t => {
  let authenticatedCalls=0;
  const http=createServer(async (request,response)=>{
    if(request.headers.authorization!=='Bearer '+token) {
      response.writeHead(401);response.end();return;
    }
    authenticatedCalls++;
    const mcp=new McpServer({name:'atlas-service-fixture',version:'1'});
    mcp.registerTool('get_atlas_status',{description:'test',inputSchema:{}},
      async()=>({content:[{type:'text',text:'available'}],structuredContent:{result:{available:true}}}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    response.once('close',()=>{void mcp.close()});
    await mcp.connect(transport);await transport.handleRequest(request,response);
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const address=http.address();assert.ok(address&&typeof address==='object');
  const url='http://127.0.0.1:'+address.port+'/mcp';
  const client=new McpTransport(url,token);
  t.after(async()=>{await client.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));});
  assert.deepEqual((await client.list()).map(x=>x.name),['get_atlas_status']);
  const status=await client.call('get_atlas_status',{});
  assert.equal((status as {structuredContent?:{result?:{available?:boolean}}}).structuredContent?.result?.available,true);
  assert.ok(authenticatedCalls>=2);
});
