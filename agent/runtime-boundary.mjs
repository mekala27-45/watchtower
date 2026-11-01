import {createHash,randomBytes} from 'node:crypto';
import {createToolSession,assertToolInventory,TOOL_NAMES} from './tools.mjs';

export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function emptyRuntimeState(){return {runtime_id:randomBytes(16).toString('hex'),requests:[],provider_calls:[],executions:[],proposals:[],errors:[]};}

/** Admission is called immediately before a real provider call, never by a test handler. */
export function admitModelRequest(state,sequence,params,{now=Date.now()}={}){
  assertToolInventory(params.tools?.map(t=>t.name));
  if(params.tools.some(t=>t.type!=='function'))fail('non_function_tool');
  if(now>=sequence.deadline)fail('sequence_timeout');
  if(sequence.model_requests>=3)fail('model_turn_budget_exhausted');
  sequence.model_requests++;
  const request={request_id:'request-'+sequence.model_requests,started_at:new Date(now).toISOString(),
    tool_inventory:params.tools.map(t=>t.name),tool_inventory_digest:hash(params.tools),
    prompt_digest:hash(params.prompt),output_token_cap:256,temperature:0,status:'prepared',provider_dispatched:false};
  state.requests.push(request);return request;
}

export function recordProviderPart(state,request,part,sequence){
  if(part.type==='tool-call'){
    const call={request_id:request.request_id,provider_call_id:part.toolCallId,tool:part.toolName,
      input_text:String(part.input),model_requested:true,origin:'ollama_provider_response',provider_executed:part.providerExecuted===true};
    if(Buffer.byteLength(call.input_text)>4096)call.invalid='input_too_large';
    else try{call.arguments=JSON.parse(call.input_text);}catch{call.invalid='malformed_tool_json';}
    state.provider_calls.push(call);
    if(sequence){sequence.tool_requests=(sequence.tool_requests??0)+1;call.budget_ordinal=sequence.tool_requests;
      if(sequence.tool_requests>4){call.invalid='tool_budget_exhausted';state.errors.push({code:'tool_budget_exhausted',provider_call_id:call.provider_call_id});fail('tool_budget_exhausted');}}
  }
  if(part.type==='finish'){
    request.status='completed';request.finish_reason=part.finishReason;
    request.generated_tokens=part.usage?.outputTokens?.total??null;
    request.input_tokens=part.usage?.inputTokens?.total??null;
  }
  if(part.type==='error'){request.status='provider_error';state.errors.push({code:'provider_stream_error',request_id:request.request_id});}
}

/** Calls require a matching, unused provider response; the model cannot mint a receipt. */
export function executeObservedCall(state,sequence,bundle,{name,args,callId}){
  if(Date.now()>=sequence.deadline)fail('sequence_timeout');
  if(sequence.tool_executions>=4)fail('tool_budget_exhausted');
  const consumed=new Set(state.executions.map(e=>e.provider_call_id));
  const matching=state.provider_calls.filter(c=>!c.invalid&&!c.provider_executed&&!consumed.has(c.provider_call_id)&&c.tool===name&&same(c.arguments,args));
  const exact=matching.filter(c=>c.provider_call_id===callId);
  const call=exact.length===1?exact[0]:matching.length===1?matching[0]:null;
  if(!call)fail('unproven_model_origin');
  if(!TOOL_NAMES.includes(name))fail('tool_not_permitted');
  sequence.tool_executions++;
  // Replay only already-executed domain operations to reconstruct immutable cursors and budgets.
  // The replay events stay contract_test and never enter the model ledger.
  if(!/^[a-f0-9]{32}$/.test(state.runtime_id??''))fail('runtime_identity_missing');
  const handler=createToolSession(bundle,{cursorSeed:hash({runtime_id:state.runtime_id,bundle_digest:bundle.digest})});
  for(const previous of state.executions)handler.invokeTest(previous.tool,previous.arguments);
  const result=handler.invokeTest(name,args),event=handler.trace.at(-1);
  const receipt={...event,origin:'eve_tool_execute',model_requested:true,provider_call_id:call.provider_call_id,
    eve_call_id:callId,request_id:call.request_id,arguments:structuredClone(args),result:structuredClone(result),
    bundle_digest:bundle.digest,namespace:bundle.namespace};
  if(result.proposal){
    const proposal={...result.proposal,execution_mode:'actual_local_inference',model_requested:true,
      runtime_receipt:{provider_call_id:call.provider_call_id,eve_call_id:callId,request_id:call.request_id}};
    proposal.id='proposal-'+hash(proposal);result.proposal=proposal;receipt.result=structuredClone(result);state.proposals.push(proposal);
  }
  receipt.result_digest=hash(result);state.executions.push(receipt);return result;
}
