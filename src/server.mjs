import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const token = process.env.RELAY_ACCESS_TOKEN || '';
const modelId = process.env.RELAY_MODEL || 'qwen/qwen3-coder-next';
const maxActive = Math.max(1, Math.min(4, Number(process.env.RELAY_MAX_ACTIVE || 1)));
if (token.length < 24) throw new Error('RELAY_ACCESS_TOKEN must be 24+ characters');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const files = {'/':['index.html','text/html'], '/app.js':['app.js','application/javascript'], '/style.css':['style.css','text/css']};
const sessions = new Map();
let active = 0;
let runtime;
function send(res,code,value) { res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value)); }
function allowed(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /,''));
  const expected = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got,expected);
}
async function readBody(req) {
  let text = '';
  for await (const chunk of req) { text += chunk.toString('utf8'); if (text.length > 12000) throw new Error('Request too large'); }
  return JSON.parse(text || '{}');
}
const summary = (s) => ({id:s.id,title:s.title,costUsd:s.costUsd,busy:s.busy,createdAt:s.createdAt});
const event = (res,type,data) => { if (!res.destroyed) res.write(JSON.stringify({type,data})+'\n'); };
async function createPi() {
  runtime ||= await ModelRuntime.create();
  const model = runtime.getModel('openrouter',modelId);
  if (!model) throw new Error('Model unavailable in Pi OpenRouter catalog: '+modelId);
  const loader = new DefaultResourceLoader({systemPromptOverride:()=> 'You are Relay, a concise and helpful AI assistant. No tools are enabled in this initial release. Never claim to have read files, used Atlas, or executed operations.'});
  await loader.reload();
  const {session} = await createAgentSession({modelRuntime:runtime,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(),noTools:'all'});
  return session;
}
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self';script-src 'self';style-src 'self';connect-src 'self';frame-ancestors 'none';base-uri 'none'");
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method==='GET' && path==='/health') return send(res,200,{ok:true,service:'relay'});
  if (req.method==='GET' && files[path]) {
    const [file,type]=files[path];
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});
    return createReadStream(join(staticDir,file)).pipe(res);
  }
  if (!path.startsWith('/api/')) return send(res,404,{error:'Not found'});
  if (!allowed(req)) return send(res,401,{error:'Invalid Relay token'});
  try {
    if (req.method==='GET' && path==='/api/status') return send(res,200,{harness:'Pi',provider:'OpenRouter',model:modelId,active,maxActive,atlas:'not connected'});
    if (req.method==='GET' && path==='/api/sessions') return send(res,200,{sessions:[...sessions.values()].map(summary).reverse()});
    if (req.method==='POST' && path==='/api/sessions') {
      if (sessions.size>=30) return send(res,429,{error:'Session limit reached'});
      const pi=await createPi();
      const s={id:randomUUID(),pi,title:'New conversation',turns:[],costUsd:0,busy:false,createdAt:new Date().toISOString()};
      sessions.set(s.id,s);
      return send(res,201,{session:summary(s)});
    }
    const match=path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/messages|\/abort)?$/);
    if (!match) return send(res,404,{error:'Unknown API route'});
    const s=sessions.get(match[1]);
    if (!s) return send(res,404,{error:'Session not found'});
    if (req.method==='GET' && !match[2]) return send(res,200,{session:summary(s),turns:s.turns});
    if (req.method==='POST' && match[2]==='/abort') { if(s.busy) await s.pi.abort(); return send(res,200,{ok:true}); }
    if (req.method!=='POST' || match[2]!=='/messages') return send(res,405,{error:'Method not allowed'});
    if (s.busy) return send(res,409,{error:'Session already running'});
    if (active>=maxActive) return send(res,429,{error:'All agent slots are busy'});
    const data=await readBody(req);
    const prompt=typeof data.message==='string' ? data.message.trim() : '';
    if (!prompt || prompt.length>6000) return send(res,400,{error:'Message length must be 1–6000'});
    s.turns.push({role:'user',text:prompt});
    if (s.title==='New conversation') s.title=prompt.slice(0,55);
    s.busy=true; active++;
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
    event(res,'start',summary(s));
    const unsubscribe=s.pi.subscribe((e)=>{
      if(e.type==='message_update' && e.assistantMessageEvent?.type==='text_delta') event(res,'delta',{text:e.assistantMessageEvent.delta});
      if(e.type==='message_end' && e.message?.role==='assistant') {
        const cost=Number(e.message.usage?.cost?.total||0);
        if(Number.isFinite(cost)&&cost>=0) s.costUsd+=cost;
      }
      if(e.type==='tool_execution_start') event(res,'tool',{name:e.toolName,status:'started'});
      if(e.type==='tool_execution_end') event(res,'tool',{name:e.toolName,status:e.isError?'failed':'completed'});
    });
    try {
      await s.pi.prompt(prompt);
      const text=s.pi.getLastAssistantText()||'';
      s.turns.push({role:'assistant',text});
      event(res,'done',{text,costUsd:s.costUsd});
    } catch(err) { event(res,'error',{message:String(err.message||err).slice(0,240)}); }
    finally { unsubscribe();s.busy=false;active--;if(!res.destroyed)res.end(); }
  } catch(err) { if(!res.headersSent) send(res,400,{error:String(err.message||err).slice(0,240)});else res.end(); }
});
server.listen(Number(process.env.PORT||8765),process.env.HOST||'0.0.0.0',()=>console.log('Relay started'));
process.on('SIGTERM',()=>{server.close();for(const s of sessions.values())s.pi.dispose();});
