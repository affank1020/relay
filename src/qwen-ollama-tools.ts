import { randomUUID } from 'node:crypto';

export type ToolSpec={type?:string;function?:{name?:string;parameters?:Record<string,unknown>}};
type Choice={index:number;message?:{role?:string;content?:unknown;tool_calls?:unknown[]};finish_reason?:string|null};
export interface OpenAICompletion {
  id?:string;created?:number;model?:string;choices?:Choice[];
  usage?:unknown;
}
export type QwenRecovery={kind:'none'|'recovered'|'invalid';completion:OpenAICompletion};

/**
 * Ollama qwen3-coder sometimes emits a bare <function=...> block as content
 * rather than returning OpenAI tool_calls. Only canonicalise a COMPLETE
 * single function block whose tool name and parameters were in the exact
 * submitted API request. We do not execute model-provided text ourselves.
 * Pi still performs its normal tool schema and per-task permissions checks.
 */
export function recoverQwenToolCall(completion:OpenAICompletion,tools:readonly ToolSpec[]):QwenRecovery {
  const choice=completion.choices?.[0],message=choice?.message;
  if(!choice||!message||Array.isArray(message.tool_calls)&&message.tool_calls.length)
    return {kind:'none',completion};
  if(typeof message.content!=='string'||!/<function[=\s]/.test(message.content))
    return {kind:'none',completion};
  const raw=message.content;
  if(raw.length>65536)return {kind:'invalid',completion};
  const match=/<function=([a-zA-Z_][a-zA-Z0-9_]*)>\s*([\s\S]*?)\s*<\/function>\s*(?:<\/tool_call>)?\s*$/.exec(raw);
  if(!match||/<function[=\s]/.test(raw.slice(0,match.index))||
    !tools.some(t=>t.type==='function'&&t.function?.name===match[1]))
    return {kind:'invalid',completion};
  const tool=tools.find(t=>t.type==='function'&&t.function?.name===match[1])!;
  const properties=tool.function?.parameters?.properties;
  if(!properties||typeof properties!=='object'||Array.isArray(properties))
    return {kind:'invalid',completion};
  const body=match[2];let rest=body;
  const args:Record<string,unknown>={};
  let count=0;
  const parameter=/<parameter=([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/parameter>/g;
  for(const p of body.matchAll(parameter)){
    if(!Object.hasOwn(properties,p[1])||Object.hasOwn(args,p[1])||++count>24)
      return {kind:'invalid',completion};
    const metadata=(properties as Record<string,unknown>)[p[1]];
    const typ=typeof metadata==='object'&&metadata!==null
      ?(metadata as Record<string,unknown>).type:undefined;
    const value=p[2].trim();
    if(value.length>12000)return {kind:'invalid',completion};
    if(typ==='string')args[p[1]]=value;
    else {
      try{args[p[1]]=JSON.parse(value);}
      catch{return {kind:'invalid',completion};}
    }
    rest=rest.replace(p[0],'');
  }
  if(!count||rest.trim()||Object.keys(args).length!==count)
    return {kind:'invalid',completion};
  const recovered={...completion,choices:[{...choice,finish_reason:'tool_calls',message:{
    ...message,content:null,
    tool_calls:[{id:'call_'+randomUUID().replaceAll('-',''),type:'function',
      function:{name:match[1],arguments:JSON.stringify(args)}}]
  }}]};
  return {kind:'recovered',completion:recovered};
}

export function completionAsSse(result:OpenAICompletion):string {
  const choice=result.choices?.[0];
  if(!choice||!choice.message)throw new Error('Missing Ollama completion message');
  const base={id:result.id??'chatcmpl-relay',object:'chat.completion.chunk',
    created:result.created??Math.floor(Date.now()/1000),model:result.model??'ollama'};
  const message=choice.message;
  const calls=message.tool_calls;
  const chunks:Array<Record<string,unknown>>=[];
  if(Array.isArray(calls)&&calls.length) {
    const deltaCalls=calls.map((item,index)=>{
      const v=item as {id:string;function:{name:string;arguments:string}};
      return {index,id:v.id,type:'function',function:{name:v.function.name,
        arguments:v.function.arguments}};
    });
    chunks.push({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:deltaCalls},
      finish_reason:null}]});
  }else{
    chunks.push({...base,choices:[{index:0,delta:{role:'assistant',
      content:typeof message.content==='string'?message.content:''},finish_reason:null}]});
  }
  chunks.push({...base,choices:[{index:0,delta:{},
    finish_reason:choice.finish_reason??(calls?.length?'tool_calls':'stop')}]});
  if(result.usage)chunks.push({...base,choices:[],usage:result.usage});
  return chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n';
}
