#!/usr/bin/env node
// Loopback-only, zero-credential UI preview. Every model and Atlas response is a fixture.
import {createServer} from 'node:http';
import {readFileSync,watch} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {context} from 'esbuild';

const root=join(dirname(fileURLToPath(import.meta.url)),'..'),port=Number(process.env.RELAY_UI_PORT||4173);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid RELAY_UI_PORT');
const subscribers=new Set();
const reload=()=>{for(const res of subscribers)try{res.write('event: reload\ndata: updated\n\n');}catch{subscribers.delete(res);}};
const models=[
  {key:'openrouter/cohere/north-mini-code:free',label:'OpenRouter · cohere/north-mini-code:free'},
  {key:'ollama/qwen3:4b',label:'MacBook · qwen3:4b'},
  {key:'ollama/qwen3:8b',label:'MacBook · qwen3:8b'}
];
// Preview-only IDs; no credentialed Atlas access.
const previewProject='f81b5f68-5a1b-414f-949d-9af62977387d';
const previewCheckout='df1c2c81-1383-4533-92ed-b512dbd5646b';
const previewLogical='4d2c2103-360b-4913-8240-f9767de1bd48';
const sessions=[],tasks=[],events=[];let sequence=0;
const summary=s=>({...s,busy:tasks.some(t=>t.conversationId===s.id&&['running','queued'].includes(t.state)),costUsd:0,usage:{costKind:'estimated',tokens:1450,unknown:false}});
function newSession(title='New conversation',modelKey=models[0].key){const s={id:randomUUID(),title,modelKey,createdAt:new Date().toISOString()};sessions.unshift(s);return s;}
function emit(s,t,type,state,other={}){events.push({schemaVersion:1,id:randomUUID(),sequence:++sequence,timestamp:new Date().toISOString(),conversationId:s.id,taskId:t.id,agentRunId:t.id,invocationId:null,type,state,tool:null,atlasOperationId:null,projectId:null,workspaceId:null,selectedNodeId:null,executingNodeId:null,...other});}
function newTask(s,prompt,result,{tool=false,immediate=false,requestId=randomUUID()}={}){
  const t={id:randomUUID(),conversationId:s.id,requestId,prompt,state:'running',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'',error:null,usage:[]};
  tasks.push(t);if(s.title==='New conversation')s.title=prompt.slice(0,55);emit(s,t,'task','running');
  const finish=()=>{
    if(t.state==='cancelled')return;
    if(tool){const id=randomUUID();emit(s,t,'tool','started',{invocationId:id,tool:'get_atlas_status'});emit(s,t,'tool','completed',{invocationId:id,tool:'get_atlas_status'});}
    t.result=result;t.state='completed';emit(s,t,'task','completed');
  };
  if(immediate)finish();else setTimeout(finish,800);return t;
}
const demo=newSession('Check Atlas status','ollama/qwen3:4b');
newTask(demo,'Use Atlas MCP to get the current Atlas status.',
  '## Atlas overview\n\n**Mock data only** — this preview does not call the real Atlas server.\n\n- **Fabric:** Active\n- **Views:** Available\n- **Projects:** 12 (sample)\n\nOpen **Activity** for a sample tool receipt.\n\n[Open Atlas](https://atlas.affankhan.dev)',{tool:true,immediate:true});
const planning=newSession('Plan the next development sprint','ollama/qwen3:8b');
newTask(planning,'Outline a development workflow.','### Workflow\n\n1. Choose a project and workspace.\n2. Review proposed changes.\n3. Run checks.\n\n> This is sample data, not a real agent run.',{immediate:true});
const response=prompt=>prompt.toLowerCase().includes('project')
  ?'### Projects\n\n- **Atlas** — Agent orchestration\n- **Portfolio Site** — Website\n- **AI Football** — Simulation\n\n*Sample data only.*'
  :'### Local preview\n\nThis is a **mock response**. No model inference or Atlas operation occurred.\n\n- Markdown works.\n- Conversation navigation works.\n- Edits to CSS and TypeScript trigger reload.';
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function readBody(req){let s='';for await(const part of req){s+=part;if(s.length>16000)throw Error('Request too large');}return JSON.parse(s||'{}');}
const appPath=join(root,'.relay-dev','app.js');
const bundler=await context({entryPoints:[join(root,'src','client.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',outfile:appPath,logLevel:'warning',
  plugins:[{name:'reload',setup(build){build.onEnd(result=>{if(!result.errors.length)reload();});}}]});
await bundler.rebuild();await bundler.watch();
const watcher=watch(join(root,'public'),(_event,name)=>{if(['index.html','style.css'].includes(String(name)))reload();});
const devJs="const source=new EventSource('/__dev_events');source.addEventListener('reload',()=>location.reload());";
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/','http://localhost'),path=url.pathname;
    if(path==='/__dev_events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': connected\n\n');subscribers.add(res);req.on('close',()=>subscribers.delete(res));return;}
    if(path==='/__dev_reload.js'){res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});res.end(devJs);return;}
    if(path==='/'||path==='/index.html'){
      const html=readFileSync(join(root,'public','index.html'),'utf8')
        .replace('</body>','<script src="/__dev_reload.js" defer></script></body>');
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(html);return;
    }
    if(path==='/app.js'||path==='/style.css'){res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css':'application/javascript','Cache-Control':'no-store'});res.end(readFileSync(path==='/app.js'?appPath:join(root,'public','style.css')));return;}
    if(path==='/api/status'&&req.method==='GET')return json(res,200,{provider:'Preview',model:models[0].key,models,defaultModelKey:models[0].key,atlas:'mock'});
    if(path==='/api/sessions'&&req.method==='GET')return json(res,200,{sessions:sessions.map(summary)});
    if(path==='/api/sessions'&&req.method==='POST'){const b=await readBody(req);if(b.modelKey&&!models.some(m=>m.key===b.modelKey))return json(res,400,{error:'Invalid model'});return json(res,201,{session:summary(newSession('New conversation',b.modelKey||models[0].key))});}
    if(path==='/api/atlas/context/projects'&&req.method==='GET')
      return json(res,200,{projects:[{id:previewProject,name:'Atlas (sample)'}]});
    if(path==='/api/atlas/context/projects/'+previewProject+'/checkouts'&&req.method==='GET')
      return json(res,200,{checkouts:[{checkoutId:previewCheckout,projectId:previewProject,logicalWorkspaceId:previewLogical,nodeId:null,name:'Mac checkout (sample)'}]});
    if(path==='/api/tasks'&&req.method==='GET')return json(res,200,{tasks:[...tasks].reverse()});
    const m=path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/events|\/messages|\/abort|\/context)?$/);
    if(m){
      const s=sessions.find(x=>x.id===m[1]);if(!s)return json(res,404,{error:'Session not found'});
      const scoped=tasks.filter(t=>t.conversationId===s.id);
      if(!m[2]&&req.method==='GET')return json(res,200,{session:summary(s),tasks:scoped,approvals:[]});
      if(m[2]==='/context'&&req.method==='PATCH'){
        const b=await readBody(req);
        if(tasks.some(t=>t.conversationId===s.id&&['running','queued'].includes(t.state)))return json(res,409,{error:'Conversation has an active task'});
        if((b.projectId!==null&&b.projectId!==previewProject)||
           (b.checkoutId!==null&&b.checkoutId!==previewCheckout)||
           (b.checkoutId&&b.projectId!==previewProject))return json(res,409,{error:'Unavailable Atlas selection'});
        s.atlasContext=b.projectId?{projectId:previewProject,projectName:'Atlas (sample)',
          checkoutId:b.checkoutId??null,checkoutName:b.checkoutId?'Mac checkout (sample)':null,
          logicalWorkspaceId:b.checkoutId?previewLogical:null,nodeId:null}:null;
        return json(res,200,{session:summary(s)});
      }
      if(m[2]==='/events'&&req.method==='GET'){const after=Number(url.searchParams.get('after')||0),batch=events.filter(e=>e.conversationId===s.id&&e.sequence>after).slice(0,500);return json(res,200,{events:batch,nextCursor:batch.at(-1)?.sequence??after,hasMore:batch.length===500});}
      if(m[2]==='/messages'&&req.method==='POST'){const b=await readBody(req);if(typeof b.message!=='string'||!b.message.trim())return json(res,400,{error:'Message required'});const prev=scoped.find(t=>t.requestId===b.requestId);return json(res,202,{task:prev||newTask(s,b.message,response(b.message),{requestId:b.requestId})});}
      if(m[2]==='/abort'&&req.method==='POST'){for(const t of scoped)if(t.state==='running'){t.state='cancelled';emit(s,t,'task','cancelled');}return json(res,200,{ok:true});}
    }
    const retry=path.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/);
    if(retry&&req.method==='POST'){const t=tasks.find(x=>x.id===retry[1]);if(!t)return json(res,404,{error:'Task not found'});const parent=sessions.find(x=>x.id===t.conversationId),s=newSession('New conversation',parent?.modelKey);return json(res,202,{task:newTask(s,t.prompt,response(t.prompt))});}
    return json(res,404,{error:'Unknown preview route'});
  }catch(e){return json(res,400,{error:e instanceof Error?e.message:'Invalid preview request'});}
});
server.listen(port,'127.0.0.1',()=>{console.log('Relay UI preview at http://localhost:'+port);console.log('Hot reload enabled; all Atlas and model data is simulated.');});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{watcher.close();for(const res of subscribers)res.end();server.close();await bundler.dispose();process.exit(0);});
