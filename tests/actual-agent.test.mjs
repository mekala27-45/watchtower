import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TOOL_NAMES} from '../agent/tools.mjs';
import {loadFixtureBundle} from '../packages/domain/fixture-loader.mjs';
import {emptyRuntimeState,admitModelRequest,recordProviderPart,executeObservedCall} from '../agent/runtime-boundary.mjs';
import {gradeModelTransition} from '../agent/actual-ledger.mjs';
import {nativeMessages,nativeResult} from '../agent/ollama-native.mjs';
import {digest} from '../packages/domain/index.mjs';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/development/mutable_tag-development-02.json',import.meta.url)));
const bundle=loadFixtureBundle(fixture);
const sequence=()=>({deadline:Date.now()+60_000,model_requests:0,tool_executions:0});
const params=()=>({tools:TOOL_NAMES.map(name=>({type:'function',name})),prompt:[]});
function observe(state,request,id,name,args){recordProviderPart(state,request,{type:'tool-call',toolCallId:id,toolName:name,input:JSON.stringify(args)});}

test('actual boundary rejects extra runtime tools before dispatch and enforces model turns',()=>{
  const state=emptyRuntimeState(),seq=sequence();
  assert.throws(()=>admitModelRequest(state,seq,{...params(),tools:[...params().tools,{name:'eve__search',type:'function'}]}),/tool_inventory_mismatch/);
  assert.equal(seq.model_requests,0);
  for(let i=0;i<3;i++)admitModelRequest(state,seq,params());
  assert.throws(()=>admitModelRequest(state,seq,params()),/model_turn_budget_exhausted/);
  assert.equal(state.requests.length,3);
});
test('configured tool and valid arguments alone cannot manufacture model origin',()=>{
  const state=emptyRuntimeState(),seq=sequence();admitModelRequest(state,seq,params());
  assert.throws(()=>executeObservedCall(state,seq,bundle,{name:'list_changes',args:{bundle_id:bundle.id},callId:'forged'}),/unproven_model_origin/);
  assert.equal(state.executions.length,0);
});
test('provider observed tool request executes once, rejects changed arguments and replay',()=>{
  const state=emptyRuntimeState(),seq=sequence(),req=admitModelRequest(state,seq,params());
  observe(state,req,'call1','list_changes',{bundle_id:bundle.id});
  assert.throws(()=>executeObservedCall(state,seq,bundle,{name:'list_changes',args:{bundle_id:'forged'},callId:'call1'}),/unproven_model_origin/);
  const result=executeObservedCall(state,seq,bundle,{name:'list_changes',args:{bundle_id:bundle.id},callId:'call1'});
  assert.equal(result.candidates.length,1);assert.equal(state.executions[0].model_requested,true);
  assert.throws(()=>executeObservedCall(state,seq,bundle,{name:'list_changes',args:{bundle_id:bundle.id},callId:'call1'}),/unproven_model_origin/);
});
test('runtime replay restores opaque pagination cursors without crossing sessions',()=>{
  const {id,digest:oldDigest,...payload}=structuredClone(bundle);
  payload.candidates=Array.from({length:9},(_,i)=>({...payload.candidates[0],id:'candidate-'+i}));
  const value={...payload,digest:digest(payload),id:'bundle_'+digest(payload)};
  let state=emptyRuntimeState();const seq=sequence(),req=admitModelRequest(state,seq,params());
  observe(state,req,'page1','list_changes',{bundle_id:value.id});
  const first=executeObservedCall(state,seq,value,{name:'list_changes',args:{bundle_id:value.id},callId:'page1'});
  assert.equal(first.candidates.length,8);assert.equal(typeof first.next_cursor,'string');
  state=JSON.parse(JSON.stringify(state)); // Same reconstruction used across durable runtime steps.
  const args={bundle_id:value.id,cursor:first.next_cursor};observe(state,state.requests[0],'page2','list_changes',args);
  const second=executeObservedCall(state,seq,value,{name:'list_changes',args,callId:'page2'});
  assert.equal(second.candidates.length,1);assert.equal(second.next_cursor,null);
  const foreign=emptyRuntimeState(),foreignSeq=sequence(),foreignReq=admitModelRequest(foreign,foreignSeq,params());
  observe(foreign,foreignReq,'forged','list_changes',args);
  assert.equal(executeObservedCall(foreign,foreignSeq,value,{name:'list_changes',args,callId:'forged'}).error,'invalid_cursor');
});
test('malformed provider JSON stays recorded but cannot execute; timeouts fail closed',()=>{
  const state=emptyRuntimeState(),seq=sequence(),req=admitModelRequest(state,seq,params());
  recordProviderPart(state,req,{type:'tool-call',toolCallId:'bad',toolName:'list_changes',input:'{'});
  assert.equal(state.provider_calls[0].invalid,'malformed_tool_json');
  assert.throws(()=>executeObservedCall(state,seq,bundle,{name:'list_changes',args:{},callId:'bad'}),/unproven_model_origin/);
  seq.deadline=Date.now()-1;assert.throws(()=>admitModelRequest(state,seq,params()),/sequence_timeout/);
});
test('malformed model calls consume the shared four-call budget before eve validation',()=>{
  const state=emptyRuntimeState(),seq=sequence(),req=admitModelRequest(state,seq,params());
  for(let i=0;i<4;i++)recordProviderPart(state,req,{type:'tool-call',toolCallId:'bad'+i,toolName:'inspect_snapshot',input:'{'},seq);
  assert.equal(seq.tool_requests,4);assert.equal(seq.tool_executions,0);
  assert.throws(()=>recordProviderPart(state,req,{type:'tool-call',toolCallId:'fifth',toolName:'inspect_snapshot',input:'{}'},seq),/tool_budget_exhausted/);
  assert.equal(state.provider_calls[4].invalid,'tool_budget_exhausted');assert.equal(state.executions.length,0);
});
test('independent model grading uses executed proposals and cannot count contract provenance',()=>{
  const state=emptyRuntimeState(),seq=sequence(),req=admitModelRequest(state,seq,params()),candidate=bundle.candidates[0];
  req.provider_dispatched=true;
  const args={candidate_id:candidate.id,kind:candidate.kind,field:candidate.field,before_evidence_id:candidate.before_evidence_id,after_evidence_id:candidate.after_evidence_id};
  observe(state,req,'proposal','propose_finding',args);
  executeObservedCall(state,seq,bundle,{name:'propose_finding',args,callId:'proposal'});
  const result=gradeModelTransition(fixture,1,bundle,state,{status:'completed',reply:''});
  assert.equal(result.grade.matched,1);assert.equal(result.supported_proposals,1);assert.equal(result.review_previews[0].published,false);
  state.proposals[0].execution_mode='contract_test';
  assert.throws(()=>gradeModelTransition(fixture,1,bundle,state,{status:'completed'}),/non_model_proposal/);
});

test('native transport maps actual tool calls but never promotes JSON assistant text to tools',()=>{
  const raw={done:true,model:'test',created_at:'2026-11-01T00:00:00Z',message:{role:'assistant',content:'{"name":"list_changes","arguments":{}}'},done_reason:'stop',eval_count:10,prompt_eval_count:20};
  assert.deepEqual(nativeResult(raw).content,[{type:'text',text:raw.message.content}]);
  raw.message.tool_calls=[{id:'provider-id',function:{name:'list_changes',arguments:{bundle_id:'fixture'}}}];
  const result=nativeResult(raw);assert.equal(result.content[1].toolCallId,'provider-id');assert.equal(result.finishReason.unified,'tool-calls');
  const messages=nativeMessages([{role:'assistant',content:[{type:'tool-call',toolCallId:'provider-id',toolName:'list_changes',input:{bundle_id:'fixture'}}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'provider-id',toolName:'list_changes',output:{type:'json',value:{candidates:[]}}}]}]);
  assert.equal(messages[1].content,'{"candidates":[]}');assert.equal(messages[0].tool_calls[0].function.arguments.bundle_id,'fixture');
});
