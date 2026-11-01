import {createHash} from 'node:crypto';

/** Map the documented AI SDK v4 prompt to Ollama's native message protocol. */
export function nativeMessages(prompt){
  const messages=[];
  for(const message of prompt){
    if(message.role==='system'){messages.push({role:'system',content:message.content});continue;}
    if(!Array.isArray(message.content))throw new Error('unsupported_model_content');
    if(message.role==='tool'){
      for(const part of message.content){if(part.type!=='tool-result')throw new Error('unsupported_tool_content');
        const output=part.output;const content=output?.type==='text'||output?.type==='error-text'?output.value:JSON.stringify(output?.value??output);
        messages.push({role:'tool',tool_name:part.toolName,content});}
      continue;
    }
    if(!['assistant','user'].includes(message.role))throw new Error('unsupported_message_role');
    const converted={role:message.role,content:'',tool_calls:[]};
    for(const part of message.content){
      if(part.type==='text')converted.content+=part.text;
      else if(part.type==='reasoning')continue;
      else if(part.type==='tool-call'&&message.role==='assistant')converted.tool_calls.push({id:part.toolCallId,type:'function',function:{name:part.toolName,arguments:part.input}});
      else throw new Error('unsupported_model_content');
    }
    if(!converted.tool_calls.length)delete converted.tool_calls;messages.push(converted);
  }
  return messages;
}
export function nativeResult(raw){
  if(raw.done!==true||!raw.message||raw.message.role!=='assistant')throw new Error('invalid_native_model_response');
  const content=[];
  if(raw.message.content)content.push({type:'text',text:raw.message.content});
  for(const [index,call] of (raw.message.tool_calls??[]).entries()){
    if(typeof call.function?.name!=='string'||!call.function.arguments||typeof call.function.arguments!=='object')throw new Error('invalid_native_tool_call');
    const id=call.id??'native_'+createHash('sha256').update(JSON.stringify({at:raw.created_at,call,index})).digest('hex').slice(0,32);
    content.push({type:'tool-call',toolCallId:id,toolName:call.function.name,input:JSON.stringify(call.function.arguments)});
  }
  return {content,finishReason:{unified:content.some(p=>p.type==='tool-call')?'tool-calls':raw.done_reason==='length'?'length':'stop',raw:raw.done_reason??'stop'},
    usage:{inputTokens:{total:raw.prompt_eval_count,noCache:raw.prompt_eval_count,cacheRead:0,cacheWrite:0},outputTokens:{total:raw.eval_count,text:raw.eval_count,reasoning:0}},
    warnings:[],response:{modelId:raw.model,timestamp:new Date(raw.created_at)},
    providerMetadata:{ollama:{total_duration:raw.total_duration??null,load_duration:raw.load_duration??null,prompt_eval_duration:raw.prompt_eval_duration??null,eval_duration:raw.eval_duration??null}}};
}
/** Native tool_calls only: JSON-looking assistant text is never converted into a tool. */
export function createNativeOllamaModel({model,fetch:transport=fetch}){
  async function generate(params){
    const body={model,messages:nativeMessages(params.prompt),tools:(params.tools??[]).map(t=>{if(t.type!=='function')throw new Error('unsupported_native_tool');return {type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}};}),
      stream:false,think:false,keep_alive:'30m',options:{num_gpu:0,num_ctx:8192,num_predict:Math.min(params.maxOutputTokens??256,256),temperature:0,seed:23}};
    const response=await transport('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:params.abortSignal,redirect:'error'});
    if(!response.ok)throw new Error('ollama_http_'+response.status);
    const bytes=await response.text();if(Buffer.byteLength(bytes)>131072)throw new Error('native_response_too_large');
    return nativeResult(JSON.parse(bytes));
  }
  return {specificationVersion:'v4',provider:'watchtower_ollama.native',modelId:model,supportedUrls:{},doGenerate:generate,
    async doStream(params){const result=await generate(params);return {...result,stream:new ReadableStream({start(controller){
      controller.enqueue({type:'stream-start',warnings:result.warnings});controller.enqueue({type:'response-metadata',...result.response});
      for(const [index,part] of result.content.entries()){
        if(part.type==='text'){const id='text_'+index;controller.enqueue({type:'text-start',id});controller.enqueue({type:'text-delta',id,delta:part.text});controller.enqueue({type:'text-end',id});}
        else controller.enqueue(part);
      }
      controller.enqueue({type:'finish',usage:result.usage,finishReason:result.finishReason,providerMetadata:result.providerMetadata});controller.close();
    }})};}
  };
}
