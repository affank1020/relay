import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Engine } from './engine.js';
import type { Conversation, Task, Approval } from './store.js';
import { terminal } from './store.js';
import type { RelayModels } from './models.js';

export function createPlatform(engine:Engine, token:string, staticDir:string, model:string, modelRegistry?:RelayModels) {
  if(token.length<24)throw new Error('RELAY_ACCESS_TOKEN must be 24+ characters');
  if(!model.endsWith(':free'))throw new Error('Relay requires a free OpenRouter model');
  const summary=(c:Conversation)=>({...c,busy:engine.tasks(c.id).some(t=>!terminal(t.state)),costUsd:engine.usage(c.id).costUsd,usage:engine.usage(c.id)});
  function send(res:ServerResponse,code:number,value:unknown) { res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value)); }
  async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
    req.setEncoding('utf8');let text='';
    for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16000)throw new Error('Request too large');}
    const parsed:unknown=JSON.parse(text||'{}');
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Expected an object');
    return parsed as Record<string,unknown>;
  }
  const assets:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','application/javascript'],'/style.css':['style.css','text/css']};
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self';script-src 'self';style-src 'self';connect-src 'self';frame-ancestors 'none';base-uri 'none'");
    try {
      const url=new URL(req.url||'/','http://localhost'),path=url.pathname;
      if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true,service:'relay'});
      const asset=Object.hasOwn(assets,path)?assets[path]:undefined;
      if(req.method==='GET'&&asset){const data=await readFile(join(staticDir,asset[0]));res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(data);return;}
      if(!path.startsWith('/api/'))return send(res,404,{error:'Not found'});
      const got=Buffer.from(req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'');
      const expected=Buffer.from(token);
      if(got.length!==expected.length||!timingSafeEqual(got,expected))return send(res,401,{error:'Invalid Relay token'});
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)return send(res,403,{error:'Origin not permitted'});
      if(path==='/api/status'&&req.method==='GET')return send(res,200,{harness:'Pi',provider:'OpenRouter',model,models:modelRegistry?.models??[],defaultModelKey:modelRegistry?.defaultKey,atlas:engine.gateway?'configured':'not configured',active:engine.tasks().filter(t=>['running','awaiting_approval'].includes(t.state)).length,maxActive:engine.limits.concurrency,usage:engine.usage(),limits:engine.limits});
      if(path==='/api/sessions'&&req.method==='GET')return send(res,200,{sessions:engine.store.all<Conversation>('conversations').reverse().map(summary)});
      if(path==='/api/sessions'&&req.method==='POST'){
        const data=await body(req);
        if(data.modelKey!==undefined&&typeof data.modelKey!=='string')throw new Error('Invalid model selection');
        return send(res,201,{session:summary(engine.conversation(data.modelKey as string|undefined))});
      }
      if(path==='/api/tasks'&&req.method==='GET')return send(res,200,{tasks:engine.tasks().slice(-200).reverse()});
      const conversation=path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/messages|\/events|\/abort)?$/);
      if(conversation) {
        const c=engine.store.get<Conversation>('conversations',conversation[1]);if(!c)return send(res,404,{error:'Conversation not found'});
        if(!conversation[2]&&req.method==='GET') {
          const tasks=engine.tasks(c.id);
          const turns=tasks.flatMap(t=>[{role:'user',text:t.prompt},...(t.result?[{role:'assistant',text:t.result}]:[])]);
          return send(res,200,{session:summary(c),turns,tasks,approvals:engine.store.all<Approval>('approvals').filter(a=>tasks.some(t=>t.id===a.taskId))});
        }
        if(conversation[2]==='/events'&&req.method==='GET'){
          const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor');
          const events=engine.store.events(c.id,after);return send(res,200,{events,nextCursor:events.at(-1)?.sequence??after,hasMore:events.length===500});
        }
        if(conversation[2]==='/messages'&&req.method==='POST'){
          const data=await body(req);
          if(typeof data.message!=='string'||typeof data.requestId!=='string')throw new Error('message and requestId required');
          if(data.dependencies!==undefined && (!Array.isArray(data.dependencies)||data.dependencies.some(d=>typeof d!=='string')))throw new Error('Invalid dependencies');
          const task=engine.enqueue(c.id,data.message,data.requestId,data.dependencies as string[]|undefined);
          return send(res,202,{task});
        }
        if(conversation[2]==='/abort'&&req.method==='POST'){for(const t of engine.tasks(c.id))if(!terminal(t.state))await engine.cancel(t.id);return send(res,200,{ok:true});}
      }
      const taskRoute=path.match(/^\/api\/tasks\/([a-f0-9-]+)(\/cancel|\/retry)?$/);
      if(taskRoute) {
        const task=engine.store.get<Task>('tasks',taskRoute[1]);if(!task)return send(res,404,{error:'Task not found'});
        if(req.method==='GET'&&!taskRoute[2])return send(res,200,{task});
        if(req.method==='POST'&&taskRoute[2]==='/cancel')return send(res,200,{task:await engine.cancel(task.id)});
        if(req.method==='POST'&&taskRoute[2]==='/retry'){const data=await body(req);return send(res,202,{task:engine.retry(task.id,data.reconciled===true)});}
      }
      const approval=path.match(/^\/api\/approvals\/([a-f0-9-]+)$/);
      if(approval&&req.method==='POST'){const data=await body(req);if(typeof data.approved!=='boolean')throw new Error('approved must be boolean');return send(res,200,{approval:engine.decide(approval[1],data.approved)});}
      return send(res,404,{error:'Unknown API route'});
    }catch(error){
      // Only deterministic validation errors are exposed. Provider/tool errors are recorded as safe task states.
      const text=error instanceof Error?error.message:'Request failed';
      const safe=/^(Invalid model selection|Message length|A stable|Conversation|Request identity|Task queue|Invalid depend|Parent task|Inference budget|Task cannot|Explicit reconciliation|Approval is|Task is|approved must|message and|Invalid event|Request too|Expected an)/.test(text)?text:'Request could not be completed';
      if(!res.headersSent)send(res,400,{error:safe});else res.end();
    }
  });
  server.requestTimeout=30000;
  return server;
}
