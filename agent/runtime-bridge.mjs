import {readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {wrapLanguageModel} from 'ai';
import {createNativeOllamaModel} from './ollama-native.mjs';
import {hash,emptyRuntimeState,admitModelRequest,recordProviderPart,executeObservedCall} from './runtime-boundary.mjs';

const safe=id=>{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('invalid_runtime_identity');return id;};
function runtimeRoot(){const root=process.env.WATCHTOWER_RUNTIME_DIR;if(!root)throw new Error('runtime_directory_required');return resolve(root);}
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function write(path,value){const temporary=path+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');renameSync(temporary,path);}
function paths(sessionId){const dir=runtimeRoot(),input=read(join(dir,safe(sessionId)+'.input.json'));return {input,state:join(dir,safe(sessionId)+'.state.json'),sequence:join(dir,safe(input.sequence_id)+'.sequence.json')};}
async function locked(sessionId,operation){
  const p=paths(sessionId),lock=p.sequence+'.lock',deadline=Date.now()+5000;
  for(;;){try{mkdirSync(lock);break;}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,5));}}
  try{const state=existsSync(p.state)?read(p.state):emptyRuntimeState(),sequence=read(p.sequence);
    try{return await operation(state,sequence,p.input);}finally{write(p.state,state);write(p.sequence,sequence);}
  }finally{rmdirSync(lock);}
}
export async function executeRuntimeTool(name,args,ctx){
  return locked(ctx.session.id,(state,sequence,input)=>executeObservedCall(state,sequence,input.bundle,{name,args,callId:ctx.callId}));
}
export function guardedModel(sessionId){
  const {input}=paths(sessionId);
  if(!/^[a-f0-9]{64}$/.test(input.artifact_digest??''))throw new Error('pinned_artifact_required');
  let activeRequestId=null;
  const provider=createNativeOllamaModel({model:input.model,
    fetch:async(url,options)=>{if(String(url)!=='http://127.0.0.1:11434/api/chat')throw new Error('provider_route_not_permitted');
      const body=JSON.parse(options.body);
      await locked(sessionId,state=>{const request=state.requests.find(r=>r.request_id===activeRequestId);if(!request)throw new Error('unregistered_provider_request');request.provider_dispatched=true;request.status='dispatched';request.provider_route=String(url);request.provider_tools=body.tools;request.provider_options=body.options;});
      write(join(runtimeRoot(),safe(sessionId)+'.'+safe(activeRequestId)+'.provider-input.json'),{url:String(url),body});
      return fetch(url,{...options,redirect:'error'});}});
  const model=wrapLanguageModel({model:provider,middleware:{specificationVersion:'v4',
    async transformParams({params}){
      const {sequence}=paths(sessionId),remaining=read(sequence).deadline-Date.now();if(remaining<=0)throw new Error('sequence_timeout');
      return {...params,maxOutputTokens:256,temperature:0,abortSignal:AbortSignal.any([...(params.abortSignal?[params.abortSignal]:[]),AbortSignal.timeout(remaining)])};
    },
    async wrapGenerate({doGenerate,params}){
      const request=await locked(sessionId,(state,sequence)=>admitModelRequest(state,sequence,params));
      activeRequestId=request.request_id;
      try{const result=await doGenerate();await locked(sessionId,(state,sequence)=>{const r=state.requests.find(x=>x.request_id===request.request_id);for(const p of result.content)recordProviderPart(state,r,p,sequence);recordProviderPart(state,r,{type:'finish',usage:result.usage,finishReason:result.finishReason},sequence);});return result;}
      catch(error){await recordError(sessionId,request,error);throw error;}
    },
    async wrapStream({doStream,params}){
      const request=await locked(sessionId,(state,sequence)=>admitModelRequest(state,sequence,params));
      activeRequestId=request.request_id;
      try{const result=await doStream();return {...result,stream:result.stream.pipeThrough(new TransformStream({
        async transform(part,controller){await locked(sessionId,(state,sequence)=>recordProviderPart(state,state.requests.find(x=>x.request_id===request.request_id),part,sequence));controller.enqueue(part);}
      }))};}catch(error){await recordError(sessionId,request,error);throw error;}
    }
  }});
  return {model,modelContextWindowTokens:8192};
}
async function recordError(id,request,error){await locked(id,state=>{state.requests.find(x=>x.request_id===request.request_id).status='provider_error';state.errors.push({request_id:request.request_id,code:error.code??error.name??'provider_error',message:String(error.message).slice(0,500)});});}

export const TOOL_SCHEMAS={
  list_changes:{type:'object',additionalProperties:false,required:['bundle_id'],properties:{bundle_id:{type:'string',minLength:1,maxLength:256},cursor:{type:['string','null'],maxLength:256}}},
  inspect_snapshot:{type:'object',additionalProperties:false,required:['candidate_id','revision'],properties:{candidate_id:{type:'string',minLength:1,maxLength:256},revision:{enum:['before','after']}}},
  propose_finding:{type:'object',additionalProperties:false,required:['candidate_id','kind','field','after_evidence_id'],properties:{candidate_id:{type:'string',minLength:1,maxLength:256},kind:{enum:['newly_observed_release','tag_changed','prerelease_flag_changed','asset_metadata_changed','notes_text_changed']},field:{enum:['identity','tag_name','prerelease','assets','notes_digest']},before_evidence_id:{type:['string','null'],maxLength:256},after_evidence_id:{type:'string',minLength:1,maxLength:256}}}
};
