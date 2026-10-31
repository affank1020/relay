import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

/**
 * Ollama blocks non-local Host values when bound to localhost. Tailscale Serve
 * preserves the public tailnet hostname, and Node fetch/Pi cannot reliably
 * override Host. A loopback-only reverse proxy applies Host to the upstream
 * request using Node's lower-level HTTP client, while retaining HTTPS/TLS
 * verification against the original tailnet hostname.
 *
 * No listener is published to Docker, the VPS host, or the tailnet.
 */
export async function startOllamaProxy(baseUrl:string):Promise<{baseUrl:string;close:()=>Promise<void>}> {
  const upstream=new URL(baseUrl);
  const transport=upstream.protocol==='https:'?httpsRequest:httpRequest;
  const server=createServer((req,res)=>{
    const path=req.url||'';
    // Only Pi's OpenAI-compatible inference and read-only discovery are needed.
    if(!path.startsWith('/')||path.startsWith('//')){
      res.writeHead(404).end();return;
    }
    const parsed=new URL(path,'http://localhost');
    const allowed=(req.method==='GET'&&parsed.pathname==='/v1/models')||
      (req.method==='POST'&&parsed.pathname==='/v1/chat/completions');
    if(!allowed){res.writeHead(404).end();return;}
    const headers={...req.headers,host:'localhost:11434'};
    for(const name of ['connection','proxy-connection','keep-alive','upgrade','te','trailer','transfer-encoding'])delete headers[name];
    const remote=transport({
      hostname:upstream.hostname,
      port:upstream.port||undefined,
      path:parsed.pathname+parsed.search,
      method:req.method,
      headers,
      // SNI and certificate validation use the .ts.net name, not the rewritten Host.
      ...(upstream.protocol==='https:'?{servername:upstream.hostname}:{}),
    },upstreamResponse=>{
      if(res.destroyed){upstreamResponse.destroy();return;}
      const responseHeaders={...upstreamResponse.headers};
      for(const name of ['connection','proxy-connection','keep-alive','upgrade','trailer','transfer-encoding'])delete responseHeaders[name];
      res.writeHead(upstreamResponse.statusCode??502,responseHeaders);
      upstreamResponse.pipe(res);
    });
    remote.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    res.on('close',()=>remote.destroy());
    req.pipe(remote);
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address() as AddressInfo;
  return {
    baseUrl:'http://127.0.0.1:'+address.port+'/v1',
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}),
  };
}
