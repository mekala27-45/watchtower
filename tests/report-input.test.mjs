import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {validateReportInputs} from '../packages/reports/input.mjs';
import {buildUnavailableLedger} from '../agent/model-ledger.mjs';
import {buildActualLedger,gradeModelTransition} from '../agent/actual-ledger.mjs';
import {emptyRuntimeState,admitModelRequest,recordProviderPart,executeObservedCall} from '../agent/runtime-boundary.mjs';
import {TOOL_NAMES} from '../agent/tools.mjs';
import {referenceEvidence} from '../packages/domain/grader.mjs';
import {makeObservation,makeBundle} from '../packages/domain/index.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function inputs(){
 const baseline=read('reports/baseline/full.json'),subset=read('reports/baseline/model-subset.json'),plan=read('docs/evaluation-plan.json'),manifest=read('fixtures/manifest.json');
 const fixtures=['development','heldout'].flatMap(split=>readdirSync('fixtures/'+split).filter(name=>name.endsWith('.json')).map(name=>read('fixtures/'+split+'/'+name)));
 const model=buildUnavailableLedger({plan,manifest,fixtures,probe:{},sourceRevision:'test-revision'});
 baseline.execution.source_revision='test-revision';subset.execution.source_revision='test-revision';model.source_revision='test-revision';
 return {baseline,subset,model,plan,fixtures,modelArchive:{ledger:structuredClone(model),provenance:{source_revision:'test-revision'}}};
}

// These generated receipts are test inputs only; this helper never writes a model report.
function actualInputs(){
 const input=inputs(),modelConfig={model:'qwen3:0.6b',artifact_digest:'a'.repeat(64)},manifest=read('fixtures/manifest.json');
 const observation=(f,item)=>makeObservation({namespace:f.namespace,sourceId:f.source_id,state:item.expected_rejection?'unavailable':item.state,scope:item.scope,
  items:item.expected_rejection?[]:item.raw_items.map(raw=>referenceEvidence(raw,f.namespace,f.source_id)),coverage:{procedure_complete:!item.expected_rejection&&item.state==='captured',uncovered_scope:item.expected_rejection?['normalization_refused']:item.uncovered_scope??(item.state==='captured'?[]:['incomplete_observation'])}});
 const rows=input.plan.subset_ids.map((id,index)=>{
  const fixture=input.fixtures.find(f=>f.id===id),sequence={deadline:Date.now()+60000,model_requests:0,tool_executions:0};
  let before=fixture.observations[0]?observation(fixture,fixture.observations[0]):null;const transitions=[];
  for(let i=1;i<fixture.observations.length;i++){
   const after=observation(fixture,fixture.observations[i]),bundle=makeBundle(before,after,{watchlistVersion:'watchlist-v1'}),runtime=emptyRuntimeState();
   const request=admitModelRequest(runtime,sequence,{tools:TOOL_NAMES.map(name=>({type:'function',name})),prompt:[]});request.provider_dispatched=true;
   if(index===0&&i===1){const c=bundle.candidates[0],args={candidate_id:c.id,kind:c.kind,field:c.field,before_evidence_id:c.before_evidence_id,after_evidence_id:c.after_evidence_id};
    recordProviderPart(runtime,request,{type:'tool-call',toolCallId:'test-provider-call',toolName:'propose_finding',input:JSON.stringify(args)});
    executeObservedCall(runtime,sequence,bundle,{name:'propose_finding',args,callId:'test-provider-call'});
   }
   recordProviderPart(runtime,request,{type:'finish',finishReason:'stop',usage:{outputTokens:{total:1}}});
   transitions.push(gradeModelTransition(fixture,i,bundle,runtime,{status:'completed',reply:JSON.stringify({outcome:fixture.truth[i-1].outcome})}));
   if(!fixture.observations[i].expected_rejection&&after.state==='captured')before=after;
  }
  return {fixture_id:id,family:fixture.family,method:'local_agent',status:'completed',inference_attempted:true,model_request_count:transitions.length,
   model_requested_tool_calls:transitions.reduce((n,t)=>n+t.runtime.provider_calls.length,0),handler_executions:transitions.reduce((n,t)=>n+t.runtime.executions.filter(e=>e.handler_executed).length,0),
   proposed_findings:transitions.flatMap(t=>t.runtime.proposals),supported_proposals:transitions.reduce((n,t)=>n+t.supported_proposals,0),correct_noop_or_uncertainty:transitions.some(t=>t.correct_noop_or_uncertainty),quality_available:true,transitions};
 });
 input.model=buildActualLedger({plan:input.plan,manifest,rows,sourceRevision:'test-revision',model:modelConfig,probeArtifact:'test-only',runId:'actual-test'});
 Object.assign(input.model,{cpu_placement_valid:true,cpu_placement_after:{size_vram:0,digest:modelConfig.artifact_digest}});
 const probe={artifact_digest:modelConfig.artifact_digest,model:modelConfig.model,details:{quantization_level:'Q4_K_M',family:'qwen3'},cpu_placement:{size_vram:0}};
 input.modelArchive={ledger:structuredClone(input.model),probe,provenance:{source_revision:'test-revision',execution_mode:'actual_local_inference',method:'local_agent',run_id:'actual-test',plan_digest:input.plan.plan_digest,
  subset_ids:input.plan.subset_ids,subset_digest:input.model.subset_digest,generation:input.plan.generation_budgets,artifact_digest:modelConfig.artifact_digest,model:modelConfig.model,cpu_placement:{size_vram:0},actual_inference:true,runtime_inventory_verified:true}};
 return input;
}

function resealArchive(input){input.modelArchive.ledger=structuredClone(input.model);return input;}
test('report input gate admits aligned evidence and real execution records',()=>{
 const result=validateReportInputs(inputs(),'test-revision');assert.equal(result.baseline_status,'passed');assert.ok(result.baseline_execution.run_started);
});
test('report input gate rejects tampering stale plans and model substitution',()=>{
 const x=inputs();x.baseline.summary.matched++;assert.throws(()=>validateReportInputs(x,'test-revision'),/digest/);
 const y=inputs();y.model.plan_digest='wrong';assert.throws(()=>validateReportInputs(y,'test-revision'),/provenance/);
 assert.throws(()=>validateReportInputs(inputs(),'new-revision'),/stale/);
 const z=inputs();z.model.rows[0].status='completed';assert.throws(()=>validateReportInputs(z,'test-revision'),/archive/);
});
test('report input gate refuses missing and empty execution evidence',()=>{
 assert.throws(()=>validateReportInputs({},'test-revision'),/missing/);
 const x=inputs();delete x.baseline.execution;assert.throws(()=>validateReportInputs(x,'test-revision'),/plan|execution/);
});

test('actual report gate independently regrades complete denominators and separates model quality',()=>{
 const input=actualInputs(),result=validateReportInputs(input,'test-revision');
 assert.equal(result.model_status,'executed');assert.equal(result.model_execution.attempted,24);
 assert.equal(result.model_summary.matched,1);assert.ok(result.model_summary.missed>0);
 assert.equal(result.model_coverage.handler_executions,1);assert.equal(result.model_metrics.precision.value,1);
 assert.notEqual(result.model_metrics.recall.value,input.subset.summary.recall.value);
});

test('actual report gate rejects forged origin expanded inventory and tampered grading',()=>{
 const origin=actualInputs();origin.model.rows[0].transitions[0].runtime.executions[0].origin='contract_test';
 assert.throws(()=>validateReportInputs(resealArchive(origin),'test-revision'),/unproven_model_execution/);
 const inventory=actualInputs();inventory.model.rows[0].transitions[0].runtime.requests[0].tool_inventory.push('shell');
 assert.throws(()=>validateReportInputs(resealArchive(inventory),'test-revision'),/tool_inventory/);
 const grade=actualInputs();grade.model.rows[0].transitions[0].grade.matched++;
 assert.throws(()=>validateReportInputs(resealArchive(grade),'test-revision'),/independent_grade/);
});

test('actual report gate rejects lost failure cases unsupported previews and undispatched inference',()=>{
 const missing=actualInputs();missing.model.rows.pop();assert.throws(()=>validateReportInputs(resealArchive(missing),'test-revision'),/subset|denominator/);
 const published=actualInputs();published.model.rows[0].transitions[0].review_previews[0].published=true;
 assert.throws(()=>validateReportInputs(resealArchive(published),'test-revision'),/publication_mislabelled/);
 const dispatched=actualInputs();dispatched.model.rows[0].transitions[0].runtime.requests[0].provider_dispatched=false;
 assert.throws(()=>validateReportInputs(resealArchive(dispatched),'test-revision'),/provider_call|execution_count|outcome/);
});
