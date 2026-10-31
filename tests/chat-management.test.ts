import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Engine, ConversationConflictError, ConversationNotFoundError, SessionCleanupError, type Limits } from '../src/engine.js';
import { Store, type Task, type Usage } from '../src/store.js';
import { PiHarness, type Harness } from '../src/harness.js';
import { createPlatform } from '../src/platform.js';

const limits:Limits={concurrency:1,queue:64,sessionUsd:0,globalUsd:0,sessionTokens:0,reserveUsd:0,maxRunMs:5000};
const usage:Usage={input:20,output:5,cacheRead:2,cacheWrite:1,costUsd:.2,costKind:'estimated'};
const harness=(cleanup: (id:string)=>Promise<void>=async()=>{}):Harness=>({
  version:1,capabilities:{persistence:true,cancellation:true,tools:true},
  run:async request=>{request.onUsage(usage);return 'fixture answer';},
  deleteConversationSessions:cleanup
});
async function until(predicate:()=>boolean) {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Timed out');
}
async function fixture<T>(fn:(store:Store,root:string)=>Promise<T>):Promise<T>{
  const root=await mkdtemp(join(tmpdir(),'relay-chat-management-'));
  const store=new Store(join(root,'relay.sqlite'));
  try{return await fn(store,root);}
  finally{if(store.db.isOpen)store.close();await rm(root,{recursive:true,force:true});}
}

test('rename validates user input, preserves metadata and survives reopen without first-prompt overwrite',async()=>{
  await fixture(async(store,root)=>{
    const engine=new Engine(store,harness(),limits);
    const c=engine.conversation();
    store.save('conversations',{...c,modelKey:'model-pinned',futureContext:{source:'Atlas'}} as typeof c);
    for(const invalid of ['', '    ', 'x'.repeat(121), 'bad\nname', 'bad\u007fname', 1, null])
      assert.throws(()=>engine.renameConversation(c.id,invalid),/Title must/);
    assert.throws(()=>engine.renameConversation(crypto.randomUUID(),'Anything'),ConversationNotFoundError);
    const renamed=engine.renameConversation(c.id,'  New conversation  ');
    assert.equal(renamed.title,'New conversation');
    assert.equal(renamed.manualTitle,true);
    assert.equal((store.get('conversations',c.id) as Record<string,unknown>).modelKey,'model-pinned');
    assert.deepEqual((store.get('conversations',c.id) as Record<string,unknown>).futureContext,{source:'Atlas'});
    const duplicate=engine.conversation();
    engine.renameConversation(duplicate.id,'New conversation');
    const task=engine.enqueue(c.id,'first prompt should never be title','request-001');
    await until(()=>engine.tasks().find(t=>t.id===task.id)?.state==='completed');
    assert.equal(store.get<{title:string}>('conversations',c.id)?.title,'New conversation');
    const renamedAgain=engine.renameConversation(c.id,'  Custom name  ');
    assert.equal(renamedAgain.title,'Custom name');
    await engine.stop();
    // Reopen using a second Store after closing the first connection.
    store.close();
    const second=new Store(join(root,'relay.sqlite'));
    try{
      assert.equal(second.get<{title:string;manualTitle:boolean}>('conversations',c.id)?.title,'Custom name');
      assert.equal(second.get<{manualTitle:boolean}>('conversations',c.id)?.manualTitle,true);
    }finally{second.close();}
  });
});

test('purge removes private rows and Pi session files without losing spend or violating foreign keys',async()=>{
  await fixture(async(store,root)=>{
    const pi=new PiHarness(root,'cohere/north-mini-code:free');
    const engine=new Engine(store,harness(id=>pi.deleteConversationSessions(id)),{...limits,globalUsd:.25,reserveUsd:.1});
    const c=engine.conversation();
    const task=engine.enqueue(c.id,'sensitive prompt','request-001');
    await until(()=>engine.tasks().find(t=>t.id===task.id)?.state==='completed');
    const dir=join(root,'sessions',c.id);
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'conversation.jsonl'),'secret transcript');
    store.save('approvals',{id:'approval-1',taskId:task.id,invocationId:'invocation-1',tool:'test',args:{secret:'private'},state:'approved'} as import('../src/store.js').Approval);
    store.save('invocations',{id:task.id+':tool-1',state:'completed',digest:'digest',result:{secret:'private'}} as {id:string});
    assert.ok(store.events(c.id).length>0);
    const before=engine.usage();
    assert.equal(before.costUsd,.2);
    await engine.deleteConversation(c.id);
    assert.equal(store.get('conversations',c.id),undefined);
    assert.deepEqual(store.events(c.id),[]);
    assert.equal(engine.tasks().length,0);
    assert.equal(store.all('approvals').length,0);
    assert.equal(store.get('invocations',task.id+':tool-1'),undefined);
    assert.equal((store.db.prepare('PRAGMA foreign_key_check').all()).length,0);
    assert.deepEqual(store.pendingSessionDeletions(),[]);
    await assert.rejects(access(dir),/ENOENT/);
    assert.deepEqual(engine.usage(),before);
    assert.deepEqual(engine.usage(c.id),{costUsd:0,tokens:0,unknown:false,costKind:'estimated'});
    assert.equal(store.retiredUsage().count,1);
    await assert.rejects(engine.deleteConversation(c.id),ConversationNotFoundError);
    const other=engine.conversation();
    assert.throws(()=>engine.enqueue(other.id,'budget cannot be reset','request-002'),/Inference budget/);
    await engine.stop();
    store.close();
    const reopened=new Store(join(root,'relay.sqlite'));
    try{
      assert.equal(reopened.all('conversations').length,1);
      assert.equal(reopened.all('tasks').length,0);
      assert.equal(reopened.retiredUsage().costUsd,.2);
      assert.equal(reopened.retiredUsage().tokens,28);
      assert.equal(reopened.retiredUsage().count,1);
      assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{reopened.close();}
  });
});

test('refuses queued, interrupted, pending-approval and uncertain invocation records',async()=>{
  await fixture(async(store)=>{
    const engine=new Engine(store,harness(),limits);
    const c=engine.conversation();
    const task=engine.enqueue(c.id,'hello','request-001');
    await assert.rejects(engine.deleteConversation(c.id),ConversationConflictError);
    await until(()=>engine.tasks()[0]?.state==='completed');
    store.save('invocations',{id:task.id+':tool',state:'dispatched'} as {id:string});
    await assert.rejects(engine.deleteConversation(c.id),ConversationConflictError);
    store.save('invocations',{id:task.id+':tool',state:'completed'} as {id:string});
    store.save('approvals',{id:'waiting',taskId:task.id,invocationId:'waiting',tool:'test',args:{},state:'pending'} as import('../src/store.js').Approval);
    await assert.rejects(engine.deleteConversation(c.id),ConversationConflictError);
    store.save('approvals',{id:'waiting',taskId:task.id,invocationId:'waiting',tool:'test',args:{},state:'rejected'} as import('../src/store.js').Approval);
    const interrupted={...task,state:'interrupted' as const};
    store.save('tasks',interrupted);
    await assert.rejects(engine.deleteConversation(c.id),ConversationConflictError);
    store.save('tasks',task);
    await engine.stop(); // Wait for the completed job to release its active controller.
    await engine.deleteConversation(c.id);
  });
});

test('cross-conversation dependencies, parent and attempt-of links remain intact',async()=>{
  for(const reference of ['dependencies','parentId','attemptOf'] as const){
    await fixture(async(store)=>{
      const engine=new Engine(store,harness(),limits);
      const original=engine.conversation();
      const parent=engine.enqueue(original.id,'original','request-001');
      await until(()=>engine.tasks().find(t=>t.id===parent.id)?.state==='completed');
      const dependentChat=engine.conversation();
      const child=engine.enqueue(dependentChat.id,'dependent','request-002');
      await until(()=>engine.tasks().find(t=>t.id===child.id)?.state==='completed');
      const current=store.get<Task>('tasks',child.id)!;
      if(reference==='dependencies')current.dependencies=[parent.id];
      else if(reference==='parentId')current.parentId=parent.id;
      else current.attemptOf=parent.id;
      store.save('tasks',current);
      await assert.rejects(engine.deleteConversation(original.id),ConversationConflictError);
      assert.equal(store.get('conversations',original.id)!==undefined,true);
      assert.equal(store.get<Task>('tasks',child.id)?.[reference] instanceof Array ? (store.get<Task>('tasks',child.id)![reference] as string[])[0]:store.get<Task>('tasks',child.id)?.[reference],parent.id);
      await engine.stop();
    });
  }
});

test('cleanup failure leaves durable tombstone and never resurrects private history',async()=>{
  await fixture(async(store,root)=>{
    const c=new Engine(store,harness(),limits).conversation();
    const task:Task={id:crypto.randomUUID(),conversationId:c.id,requestId:'request-001',prompt:'secret',state:'completed',createdAt:new Date().toISOString(),parentId:null,dependencies:[],attemptOf:null,result:'secret answer',error:null,usage:[usage]};
    store.save('tasks',task);
    const broken=new Engine(store,harness(async()=>{throw new Error('filesystem secret failure');}),limits);
    await assert.rejects(broken.deleteConversation(c.id),SessionCleanupError);
    assert.equal(store.get('conversations',c.id),undefined);
    assert.deepEqual(store.pendingSessionDeletions(),[c.id]);
    assert.equal(store.get('tasks',task.id),undefined);
    assert.equal(store.retiredUsage().costUsd,.2);
    await assert.rejects(broken.deleteConversation(c.id),ConversationNotFoundError);
    const pi=new PiHarness(root,'cohere/north-mini-code:free');
    const dir=join(root,'sessions',c.id);
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'old.jsonl'),'secret');
    const resumed=new Engine(store,harness(id=>pi.deleteConversationSessions(id)),limits);
    resumed.start();
    await until(()=>store.pendingSessionDeletions().length===0);
    await assert.rejects(access(dir),/ENOENT/);
    assert.equal(store.retiredUsage().count,1);
    await resumed.stop();await broken.stop();
  });
});

test('HTTP contract enforces bearer token, origin, validation, 409 conflict and 204 deletion',async()=>{
  await fixture(async(store)=>{
    let release!:()=>void;
    const blocker=new Promise<void>(resolve=>{release=resolve;});
    const gateHarness=harness();
    const engine=new Engine(store,{...gateHarness,run:async request=>{await blocker;request.onUsage(usage);return 'fixture answer';}},limits);
    const token='relay-chat-management-test-token';
    const server=createPlatform(engine,token,'.','cohere/north-mini-code:free');
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    assert.ok(address&&typeof address==='object');
    const base='http://127.0.0.1:'+address.port;
    const call=(path:string,method:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    try {
      const create=await call('/sessions','POST',{});assert.equal(create.status,201);
      const c=(await create.json() as {session:{id:string}}).session;
      assert.equal((await fetch(base+'/api/sessions/'+c.id,{method:'DELETE'})).status,401);
      assert.equal((await call('/sessions/'+c.id,'DELETE',undefined,{Origin:'https://attacker.example'})).status,403);
      for(const title of ['', '   ', 'x'.repeat(121), 'invalid\nname']){
        const bad=await call('/sessions/'+c.id,'PATCH',{title});
        assert.equal(bad.status,400);
      }
      assert.equal((await call('/sessions/'+c.id,'PATCH',{title:'valid',modelKey:'not allowed'})).status,400);
      const rename=await call('/sessions/'+c.id,'PATCH',{title:'  My saved chat  '});
      assert.equal(rename.status,200);
      assert.equal((await rename.json() as {session:{title:string}}).session.title,'My saved chat');
      const active=engine.enqueue(c.id,'queued','request-123');
      await until(()=>engine.tasks().find(t=>t.id===active.id)?.state==='running');
      const conflict=await call('/sessions/'+c.id,'DELETE');
      assert.equal(conflict.status,409);
      assert.equal(store.get('conversations',c.id)!==undefined,true);
      release();
      await until(()=>engine.tasks().find(t=>t.id===active.id)?.state==='completed');
      await engine.stop(); // Wait for active-controller release before DELETE.
      const done=await call('/sessions/'+c.id,'DELETE');
      assert.equal(done.status,204);assert.equal(await done.text(),'');
      assert.equal((await call('/sessions/'+c.id,'DELETE')).status,404);
      assert.equal((await call('/sessions/'+c.id,'PATCH',{title:'gone'})).status,404);
      const list=await call('/sessions','GET');
      assert.equal((await list.json() as {sessions:unknown[]}).sessions.length,0);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await engine.stop();}
  });
});

test('V1 -> V2 migration keeps existing data and is safe on repeated open',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-migrate-'));
  const path=join(root,'old.sqlite');
  try{
    const db=new DatabaseSync(path);
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),request_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(conversation_id,request_id));
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);
      CREATE TABLE approvals(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE invocations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const c={id:crypto.randomUUID(),title:'Pre-migration',createdAt:new Date().toISOString()};
    db.prepare('INSERT INTO conversations(id,data) VALUES(?,?)').run(c.id,JSON.stringify(c));
    db.close();
    for(let i=0;i<2;i++){
      const store=new Store(path);
      assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,2);
      assert.equal(store.get<{title:string}>('conversations',c.id)?.title,'Pre-migration');
      assert.equal(store.retiredUsage().count,0);
      store.close();
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Pi session cleanup refuses symlinks and does not delete outside files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-pi-purge-'));
  try{
    const pi=new PiHarness(root,'cohere/north-mini-code:free');
    const id=crypto.randomUUID();
    const outside=join(root,'outside.jsonl');
    await writeFile(outside,'retain me');
    const sessions=join(root,'sessions');await mkdir(sessions);
    const {symlink}=await import('node:fs/promises');
    await symlink(outside,join(sessions,id));
    await assert.rejects(pi.deleteConversationSessions(id),/Unsafe/);
    assert.equal(await readFile(outside,'utf8'),'retain me');
    await assert.rejects(pi.deleteConversationSessions('../outside'),/Invalid conversation ID/);
  }finally{await rm(root,{recursive:true,force:true});}
});
