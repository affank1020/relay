import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { completionAsSse, recoverQwenToolCall, type OpenAICompletion } from './qwen-ollama-tools.js';

/**
 * Loopback-only Ollama reverse proxy: set Host for Tailscale Serve, preserving
 * upstream TLS verification. Qwen3-Coder has an Ollama parser bug that leaks
 * bare <function=...> into content rather than structured tool_calls. For
 * tool-enabled Qwen3-Coder turns only, request a complete response and convert
 * a strictly parsed, allowlisted call back into ordinary OpenAI protocol.
 * All execution, schemas and approvals still belong to Pi/Relay.
 */
export async function startOllamaProxy(baseUrl:string):Promise<{baseUrl:string;close:()=>Promise<void>}> {
  const upstream=new URL(baseUrl);
  const transport=upstream.protocol==='https:'?httpsRequest:httpRequest;
  const server=createServer((req,res)=>{
    const path=req.url||'';
    if(!path.startsWith('/')||path.startsWith('//')){
      res.writeHead(404).end();return;
    }
    const parsed=new URL(path,'http://localhost');
    const allowed=(req.method==='GET'&&parsed.pathname==='/v1/models')||
      (req.method==='POST'&&parsed.pathname==='/v1/chat/completions');
    if(!allowed){res.writeHead(404).end();return;}

    const headers:Record<string,string|string[]|number|undefined>={
      ...req.headers,host:'localhost:11434'
    };
    for(const name of ['connection','proxy-connection','keep-alive','upgrade','te','trailer','transfer-encoding'])
      delete headers[name];

    const dispatch=(body?:Buffer,intercept=false,stream=false,tools:unknown[]=[])=>{
      if(body)headers['content-length']=body.length;
      const remote=transport({
        hostname:upstream.hostname,port:upstream.port||undefined,
        path:parsed.pathname+parsed.search,method:req.method,headers,
        ...(upstream.protocol==='https:'?{servername:upstream.hostname}:{}),
      },upstreamResponse=>{
        if(res.destroyed){upstreamResponse.destroy();return;}
        const status=upstreamResponse.statusCode??502;
        if(!intercept||status!==200){
          const responseHeaders:Record<string,string|string[]|number|undefined>={...upstreamResponse.headers};
          for(const name of ['connection','proxy-connection','keep-alive','upgrade','trailer','transfer-encoding'])
            delete responseHeaders[name];
          res.writeHead(status,responseHeaders);
          upstreamResponse.pipe(res);
          return;
        }
        const chunks:Buffer[]=[];let length=0;
        upstreamResponse.on('data',(chunk:Buffer)=>{
          length+=chunk.length;
          if(length>2_000_000){upstreamResponse.destroy();
            if(!res.headersSent)res.writeHead(502);
            res.end('Ollama response too large to validate');return;
          }
          chunks.push(chunk);
        });
        upstreamResponse.on('end',()=>{
          if(res.writableEnded)return;
          try{
            const completion=JSON.parse(Buffer.concat(chunks).toString('utf8')) as OpenAICompletion;
            const recovered=recoverQwenToolCall(completion,tools);
            if(recovered.kind==='invalid')throw Error('Malformed Qwen tool call was not executed');
            if(stream){
              const text=completionAsSse(recovered.completion);
              res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
              res.end(text);
            }else {
              res.writeHead(200,{'Content-Type':'application/json'});
              res.end(JSON.stringify(recovered.completion));
            }
          }catch{
            if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});
            res.end(JSON.stringify({error:{message:
              'Ollama returned a malformed Qwen3-Coder tool call; nothing was executed'}}));
          }
        });
        upstreamResponse.on('error',()=>{
          if(!res.headersSent)res.writeHead(502);
          res.end();
        });
      });
      remote.on('error',()=>{
        if(!res.headersSent)res.writeHead(502);
        res.end();
      });
      remote.setTimeout(240000,()=>remote.destroy());
      res.on('close',()=>remote.destroy());
      if(body)remote.end(body);else req.pipe(remote);
    };

    if(req.method!=='POST'){dispatch();return;}
    const parts:Buffer[]=[];let length=0;
    req.on('data',(chunk:Buffer)=>{
      length+=chunk.length;
      if(length>2_000_000){
        req.pause();
        res.writeHead(413).end('Ollama request too large');
      }else parts.push(chunk);
    });
    req.on('end',()=>{
      if(res.writableEnded)return;
      const input=Buffer.concat(parts);
      let parsedBody:unknown;
      try{parsedBody=JSON.parse(input.toString('utf8'));}catch{
        res.writeHead(400).end('Invalid JSON');return;
      }
      const request=parsedBody as {model?:unknown;tools?:unknown;stream?:unknown};
      const intercept=typeof request.model==='string'&&
        /^qwen3-coder(?::|$)/.test(request.model)&&
        Array.isArray(request.tools)&&request.tools.length>0;
      const stream=request.stream===true;
      if(intercept){
        dispatch(Buffer.from(JSON.stringify({...request,stream:false})),true,stream,
          request.tools as unknown[]);
      }else dispatch(input);
    });
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
