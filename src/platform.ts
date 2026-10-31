import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ConversationConflictError, ConversationNotFoundError, SessionCleanupError, type Engine } from './engine.js';
import type { Conversation, Task, Approval } from './store.js';
import { terminal } from './store.js';
import { taskConsolePage, taskConsoleDetail } from './task-console-api.js';
import { refreshOllamaModels, type RelayModels } from './models.js';
import { AtlasContextError } from './atlas-context.js';
import type { CapabilityRegistry } from './capabilities.js';
import { SkillPackageError } from './skills/git.js';
import { streamConversationEvents } from './live-events.js';

export function createPlatform(engine:Engine, token:string, staticDir:string, model:string, modelRegistry?:RelayModels,capabilities?:CapabilityRegistry) {
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
      if(path==='/api/status'&&req.method==='GET'){
        if(modelRegistry)await refreshOllamaModels(modelRegistry);
        return send(res,200,{harness:'Pi',provider:modelRegistry?.ollama?'OpenRouter + Ollama':'OpenRouter',model,models:modelRegistry?.models??[],defaultModelKey:modelRegistry?.defaultKey,ollamaOnline:modelRegistry?.ollama?.online,atlas:engine.gateway?'configured':'not configured',active:engine.tasks().filter(t=>['running','awaiting_approval'].includes(t.state)).length,maxActive:engine.limits.concurrency,usage:engine.usage(),limits:engine.limits});
      }
      if(path==='/api/capabilities'&&req.method==='GET'){
        if(!capabilities)return send(res,503,{error:'Capabilities unavailable'});
        return send(res,200,await capabilities.list());
      }
      const capability=path.match(/^\/api\/capabilities\/(skills|integrations)\/([a-z0-9_-]+)$/);
      if(capability&&req.method==='PATCH'){
        if(!capabilities)return send(res,503,{error:'Capabilities unavailable'});
        const data=await body(req);
        if(Object.keys(data).length!==1||typeof data.enabled!=='boolean')
          return send(res,400,{error:'Expected enabled boolean'});
        if(!(capability[1]==='skills'?capabilities.skills.contains(capability[2]):capabilities.connections.contains(capability[2])))
          return send(res,404,{error:'Unknown capability'});
        await capabilities.update(capability[1] as 'skills'|'integrations',capability[2],data.enabled);
        return send(res,200,await capabilities.list());
      }
      if(path==='/api/skills/git/preview'&&req.method==='POST'){
        if(!capabilities)return send(res,503,{error:'Capabilities unavailable'});
        const data=await body(req);
        if(Object.keys(data).sort().join(',')!=='commit,owner,path,repo')
          return send(res,400,{error:'Provide owner, repo, pinned commit and SKILL.md path'});
        try{return send(res,200,await capabilities.previewGitSkill(data));}
        catch(error){if(error instanceof SkillPackageError)return send(res,error.status,{error:error.message});throw error;}
      }
      if(path==='/api/skills/git/install'&&req.method==='POST'){
        if(!capabilities)return send(res,503,{error:'Capabilities unavailable'});
        const data=await body(req);
        if(Object.keys(data).sort().join(',')!=='acknowledged,previewId,sha256')
          return send(res,400,{error:'Expected preview ID, digest and acknowledgement'});
        try{
          const installed=await capabilities.installGitSkill(data.previewId,data.sha256,data.acknowledged);
          return send(res,201,{installed,capabilities:await capabilities.list()});
        }catch(error){if(error instanceof SkillPackageError)return send(res,error.status,{error:error.message});throw error;}
      }
      const gitSkillDelete=path.match(/^\/api\/skills\/git\/(git-[0-9a-f]{32})$/);
      if(gitSkillDelete&&req.method==='DELETE'){
        if(!capabilities)return send(res,503,{error:'Capabilities unavailable'});
        try{
          await capabilities.uninstallGitSkill(gitSkillDelete[1]);
          return send(res,200,await capabilities.list());
        }catch(error){if(error instanceof SkillPackageError)return send(res,error.status,{error:error.message});throw error;}
      }
      if(path==='/api/sessions'&&req.method==='GET')return send(res,200,{sessions:engine.store.all<Conversation>('conversations').reverse().map(summary)});
      if(path==='/api/sessions'&&req.method==='POST'){
        const data=await body(req);
        if(data.modelKey!==undefined&&typeof data.modelKey!=='string')throw new Error('Invalid model selection');
        if(typeof data.modelKey==='string'&&data.modelKey.startsWith('ollama/')){
          if(modelRegistry)await refreshOllamaModels(modelRegistry);
          if(modelRegistry?.ollama?.online!==true)throw new Error('Local model unavailable');
        }
        return send(res,201,{session:summary(engine.conversation(data.modelKey as string|undefined))});
      }
      if(path==='/api/atlas/context/projects'&&req.method==='GET') {
        if(!engine.atlasContext)return send(res,503,{error:'Atlas not configured'});
        return send(res,200,{projects:await engine.atlasContext.projects()});
      }
      const atlasCheckouts=path.match(/^\/api\/atlas\/context\/projects\/([a-f0-9-]+)\/checkouts$/);
      if(atlasCheckouts&&req.method==='GET') {
        if(!engine.atlasContext)return send(res,503,{error:'Atlas not configured'});
        await engine.atlasContext.validate(atlasCheckouts[1],null);
        return send(res,200,{checkouts:await engine.atlasContext.checkouts(atlasCheckouts[1])});
      }
      if(path==='/api/task-console/tasks'&&req.method==='GET')return send(res,200,taskConsolePage(engine,url));
      const consoleDetail=path.match(/^\/api\/task-console\/tasks\/([a-f0-9-]+)$/);
      if(consoleDetail&&req.method==='GET'){
        const detail=taskConsoleDetail(engine,consoleDetail[1]);
        return detail?send(res,200,detail):send(res,404,{error:'Task not found'});
      }
      if(path==='/api/tasks'&&req.method==='GET')return send(res,200,{tasks:engine.tasks().slice(-200).reverse()});
      const conversation=path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/messages|\/events|\/stream|\/abort|\/context|\/reconcile-mcp-reads)?$/);
      if(conversation) {
        const c=engine.store.get<Conversation>('conversations',conversation[1]);if(!c)return send(res,404,{error:'Conversation not found'});
        if(!conversation[2]&&req.method==='PATCH') {
          const data=await body(req);
          if(Object.keys(data).length!==1 || typeof data.title!=='string')
            return send(res,400,{error:'Title must be 1–120 characters'});
          try {
            const renamed=engine.renameConversation(c.id,data.title);
            return send(res,200,{session:summary(renamed)});
          } catch(error) {
            if(error instanceof ConversationNotFoundError)return send(res,404,{error:'Conversation not found'});
            if(error instanceof Error && error.message.startsWith('Title must'))return send(res,400,{error:error.message});
            throw error;
          }
        }
        if(!conversation[2]&&req.method==='DELETE') {
          try {
            await engine.deleteConversation(c.id);
            res.writeHead(204);res.end();return;
          } catch(error) {
            if(error instanceof ConversationNotFoundError)return send(res,404,{error:'Conversation not found'});
            if(error instanceof ConversationConflictError)return send(res,409,{error:error.message});
            if(error instanceof SessionCleanupError)return send(res,503,{error:error.message});
            throw error;
          }
        }
        if(conversation[2]==='/reconcile-mcp-reads'&&req.method==='POST'){
          const data=await body(req);
          if(Object.keys(data).length!==1||data.confirmed!==true)
            return send(res,400,{error:'Explicit read reconciliation confirmation required'});
          try{return send(res,200,{reconciled:engine.reconcileMcpReadInvocations(c.id,true)});}
          catch(error){
            if(error instanceof ConversationConflictError)return send(res,409,{error:error.message});
            throw error;
          }
        }
        if(!conversation[2]&&req.method==='GET') {
          const tasks=engine.tasks(c.id);
          const turns=tasks.flatMap(t=>[{role:'user',text:t.prompt},...(t.result?[{role:'assistant',text:t.result}]:[])]);
          return send(res,200,{session:summary(c),turns,tasks,approvals:engine.store.all<Approval>('approvals').filter(a=>tasks.some(t=>t.id===a.taskId))});
        }
        if(conversation[2]==='/context'&&req.method==='PATCH'){
          const data=await body(req);
          if(!Object.hasOwn(data,'projectId')||!Object.hasOwn(data,'checkoutId')||
            Object.keys(data).some(key=>!['projectId','checkoutId'].includes(key)))
            throw new AtlasContextError(400,'Invalid Atlas context selection');
          const updated=await engine.updateContext(c.id,data.projectId,data.checkoutId);
          return send(res,200,{session:summary(updated)});
        }
        if(conversation[2]==='/events'&&req.method==='GET'){
          const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor');
          const events=engine.store.events(c.id,after);return send(res,200,{events,nextCursor:events.at(-1)?.sequence??after,hasMore:events.length===500});
        }
        if(conversation[2]==='/stream'&&req.method==='GET'){
          const after=Number(url.searchParams.get('after')||0);
          if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor');
          return streamConversationEvents(req,res,engine.store,c.id,after);
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
      if(error instanceof AtlasContextError)return send(res,error.status,{error:error.message});
      const text=error instanceof Error?error.message:'Request failed';
      const safe=/^(Atlas not configured|Conversation has an active task|Conversation context changed|Local model unavailable|Invalid model selection|Message length|A stable|Conversation|Request identity|Task queue|Invalid depend|Parent task|Inference budget|Task cannot|Explicit reconciliation|Approval is|Task is|approved must|message and|Invalid event|Invalid task|Invalid conversation filter|Request too|Expected an)/.test(text)?text:'Request could not be completed';
      if(!res.headersSent)send(res,/^(Atlas not configured)/.test(text)?503:/^(Conversation has an active task|Conversation context changed)/.test(text)?409:400,{error:safe});else res.end();
    }
  });
  server.requestTimeout=30000;
  return server;
}
