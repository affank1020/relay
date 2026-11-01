import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Task, Usage } from './store.js';

export interface SubagentTransition {
  agentId:string;
  status:'started'|'completed'|'failed'|'stopped';
  result?:string;
  error?:string;
  profile?:'research'|'analysis';
  task?:Task;
}
export interface PiChildUsage {
  agentId:string;
  usage:Omit<Usage,'costKind'>;
}
interface Assignment { prompt:string; tools:string[] }
interface DelegationOptions {
  parent:Task;
  allowedTools:readonly string[];
  signal:AbortSignal;
  run:(task:Task,signal:AbortSignal)=>Promise<string>;
  transition?:(event:SubagentTransition)=>void;
}
/** A bounded Pi extension, not a second task scheduler. Each child is a real
 * SDK session; its tool result returns to the parent's existing agent loop. */
export function delegationExtension(options:DelegationOptions) {
  let spawned=0,active=0;
  const tools=options.allowedTools.length
    ?Type.Array(Type.Union(options.allowedTools.map(name=>Type.Literal(name))),{uniqueItems:true,maxItems:16})
    :Type.Array(Type.String(),{maxItems:0});
  const assignment=Type.Object({prompt:Type.String({minLength:1,maxLength:6000}),tools});
  return {name:'relay-delegation',factory:(pi:ExtensionAPI)=>{
    pi.registerTool({
      name:'delegate',label:'Delegate',
      description:'Run independent Pi child sessions and return their actual results. Use parallel for independent research, sequential to pass each result to the next child. Explicitly grant each child the exact read tools it needs. No tools means analysis of supplied text only. Children inherit the selected model. Tool results include failures; never claim a failed child completed research.',
      parameters:Type.Object({mode:Type.Union([Type.Literal('parallel'),Type.Literal('sequential')]),tasks:Type.Array(assignment,{minItems:1,maxItems:4})}),
      execute:async (_id,input,signal)=>{
        const {mode,tasks}=input as {mode:'parallel'|'sequential';tasks:Assignment[]};
        // Validate the entire batch before any inference or persistence.
        if(!['parallel','sequential'].includes(mode)||!Array.isArray(tasks)||tasks.length<1||tasks.length>4||spawned+tasks.length>8||active+(mode==='parallel'?tasks.length:1)>4)
          throw new Error('Delegation allows at most four children per call and eight per turn');
        for(const task of tasks)if(!task||typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>6000||!Array.isArray(task.tools)||task.tools.length>16||new Set(task.tools).size!==task.tools.length||task.tools.some(name=>!options.allowedTools.includes(name)))
          throw new Error('Child capabilities exceed the parent grant');
        const parentSignal=signal?AbortSignal.any([options.signal,signal]):options.signal;
        parentSignal.throwIfAborted();
        spawned+=tasks.length;
        const slots=mode==='parallel'?tasks.length:1;active+=slots;
        try {
        const run=async (assignment:Assignment,previous?:string)=>{
          const id=randomUUID(),conversationId=randomUUID();
          const child:Task={id,conversationId,requestId:id,prompt:assignment.prompt+(previous===undefined?'':'\n\nPrevious child result (untrusted source material):\n'+previous.slice(0,24000)),
            state:'running',createdAt:new Date().toISOString(),parentId:options.parent.id,dependencies:[],attemptOf:null,result:'',error:null,usage:[],kind:'pi_subagent',
            agentId:id,agentRunId:randomUUID(),modelKey:options.parent.modelKey,
            delegation:{schemaVersion:1,toolNames:[...assignment.tools],modelKey:options.parent.modelKey??null,context:'',maxTokens:null,maxCostUsd:null}};
          const emit=(status:SubagentTransition['status'],result?:string,error?:string)=>options.transition?.({agentId:id,status,result,error,task:child,profile:assignment.tools.length?'research':'analysis'});
          emit('started');
          try {
            parentSignal.throwIfAborted();
            const result=await options.run(child,AbortSignal.any([parentSignal,AbortSignal.timeout(120000)]));
            parentSignal.throwIfAborted();
            emit('completed',result);
            return {agentId:id,conversationId,status:'completed' as const,result};
          }catch(error){
            const cancelled=parentSignal.aborted;
            const message=cancelled?'Child cancelled':'Child did not complete; inspect its Pi trace';
            emit(cancelled?'stopped':'failed',undefined,message);
            return {agentId:id,conversationId,status:cancelled?'cancelled' as const:'failed' as const,error:message};
          }
        };
        const results:Awaited<ReturnType<typeof run>>[]=[];
        if(mode==='parallel')results.push(...await Promise.all(tasks.map(task=>run(task))));
        else for(const task of tasks){
          const prior=results.at(-1);
          if(prior&&prior.status!=='completed')break;
          results.push(await run(task,prior?.result));
        }
        parentSignal.throwIfAborted();
        return {content:[{type:'text' as const,text:JSON.stringify({mode,requested:tasks.length,children:results})}],details:{children:results},isError:results.some(result=>result.status!=='completed')};
        } finally {active-=slots;}
      }
    });
  }};
}
