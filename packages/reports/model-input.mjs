import {createHash} from 'node:crypto';
import {canonical,digest} from './index.mjs';
import {expectedFacts,gradeFacts,referenceEvidence} from '../domain/grader.mjs';
import {makeObservation,validateBundle,verify,renderFinding} from '../domain/index.mjs';

const TOOLS=['list_changes','inspect_snapshot','propose_finding'];
const OUTCOMES=['baseline_created','unchanged_in_observed_scope','partial_observation','source_unavailable','unstable_observation','insufficient_evidence'];
const same=(a,b)=>canonical(a)===canonical(b);
const check=(condition,code)=>{if(!condition)throw Error(code);};
const rawHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observation=(fixture,item)=>makeObservation({namespace:fixture.namespace,sourceId:fixture.source_id,
  state:item.expected_rejection?'unavailable':item.state,scope:item.scope,
  items:item.expected_rejection?[]:item.raw_items.map(raw=>referenceEvidence(raw,fixture.namespace,fixture.source_id)),
  coverage:{procedure_complete:!item.expected_rejection&&item.state==='captured',uncovered_scope:item.expected_rejection?['normalization_refused']:item.uncovered_scope??(item.state==='captured'?[]:['incomplete_observation'])}});
const ratio=(numerator,denominator,attempted)=>({value:attempted&&denominator?numerator/denominator:null,numerator:attempted?numerator:null,denominator:attempted?denominator:null,unit:'ratio',state:!attempted?'unavailable':denominator?'available':'not_applicable'});

/** Regrade the archived model proposals from frozen authored truth, never baseline results. */
export function validateActualModel({model,plan,modelArchive,fixtures}) {
 check(Array.isArray(fixtures)&&digest([...fixtures].sort((a,b)=>a.id.localeCompare(b.id)))===plan.dataset_digest,'model_fixture_digest_mismatch');
 check(model.method==='local_agent'&&model.execution_mode==='actual_local_inference'&&model.dataset==='authored_temporal_heldout_subset','invalid_actual_model_identity');
 check(same(model.subset_ids,plan.subset_ids)&&model.subset_digest===digest(plan.subset_ids),'invalid_actual_model_subset');
 check(model.planned===24&&model.rows.length===24&&same(model.rows.map(r=>r.fixture_id),plan.subset_ids),'incomplete_model_denominator');
 const provenance=modelArchive.provenance,probe=modelArchive.probe;
 check(provenance.execution_mode==='actual_local_inference'&&provenance.method==='local_agent'&&provenance.run_id===model.run_id&&provenance.plan_digest===plan.plan_digest,'invalid_actual_model_provenance');
 check(same(provenance.subset_ids,plan.subset_ids)&&provenance.subset_digest===model.subset_digest&&same(provenance.generation,plan.generation_budgets),'invalid_actual_model_plan');
 check(/^[a-f0-9]{64}$/.test(model.model?.artifact_digest??'')&&provenance.artifact_digest===model.model.artifact_digest&&provenance.model===model.model.model,'invalid_model_artifact');
 check(probe?.artifact_digest===model.model.artifact_digest&&probe.model===model.model.model&&probe.details?.quantization_level==='Q4_K_M'&&probe.details?.family==='qwen3','missing_actual_model_probe');
 check(probe.cpu_placement?.size_vram===0&&provenance.cpu_placement?.size_vram===0,'missing_cpu_placement');
 if(model.cpu_placement_valid)check(model.cpu_placement_after?.size_vram===0&&model.cpu_placement_after?.digest?.replace(/^sha256:/,'')===model.model.artifact_digest,'invalid_final_cpu_placement');
 const summary={expected:0,emitted:0,matched:0,missed:0,duplicates:0,unsupported:0,supported_proposals:0,correct_noop_or_uncertainty:0,unsupported_publications:0};
 const coverage={transitions:0,attempted_transitions:0,model_requests:0,provider_tool_calls:0,handler_executions:0,no_op:{correct:0,total:0},unknown:{correct:0,total:0},baseline:{correct:0,total:0}};
 const byId=new Map(fixtures.map(f=>[f.id,f]));let attempted=0,completed=0,failed=0;
 for(const row of model.rows){
  const fixture=byId.get(row.fixture_id);
  check(fixture?.split==='heldout'&&row.family===fixture.family&&row.method==='local_agent','invalid_model_fixture');
  check(Array.isArray(row.transitions)&&row.transitions.length===fixture.observations.length-1,'incomplete_model_transitions');
  let before=fixture.observations[0]?observation(fixture,fixture.observations[0]):null;
  let requests=0,preparedRequests=0,providerCalls=0,handlers=0,executions=0,supported=0;const proposals=[],requestIds=new Set();
  for(let i=0;i<row.transitions.length;i++){
   const t=row.transitions[i],expected=expectedFacts(fixture,i+1),after=observation(fixture,fixture.observations[i+1]),bundle=t.bundle;
   check(t.transition===i+1&&t.method==='local_agent'&&bundle&&validateBundle(bundle)&&t.bundle_digest===bundle.digest,'invalid_model_bundle');
   check(same(bundle.before,before)&&same(bundle.after,after),'model_bundle_fixture_mismatch');
   if(!fixture.observations[i+1].expected_rejection&&after.state==='captured')before=after;
   const runtime=t.runtime;
   check(runtime&&['requests','provider_calls','executions','proposals','errors'].every(k=>Array.isArray(runtime[k])),'missing_model_runtime');
   const localRequests=new Set();
   for(const req of runtime.requests){
    check(typeof req.request_id==='string'&&!requestIds.has(req.request_id)&&Number.isFinite(Date.parse(req.started_at)),'invalid_model_request');
    check(Array.isArray(req.tool_inventory)&&req.tool_inventory.length===3&&same([...req.tool_inventory].sort(),[...TOOLS].sort()),'invalid_model_tool_inventory');
    check(/^[a-f0-9]{64}$/.test(req.tool_inventory_digest??'')&&/^[a-f0-9]{64}$/.test(req.prompt_digest??'')&&req.output_token_cap===256&&req.temperature===0,'invalid_model_request_policy');
    check(typeof req.provider_dispatched==='boolean','missing_model_dispatch_state');
    requestIds.add(req.request_id);if(req.provider_dispatched)localRequests.add(req.request_id);
   }
   requests+=localRequests.size;preparedRequests+=runtime.requests.length;providerCalls+=runtime.provider_calls.length;executions+=runtime.executions.length;
   const calls=new Map();
   for(const call of runtime.provider_calls){
    check(localRequests.has(call.request_id)&&call.model_requested===true&&call.origin==='ollama_provider_response'&&typeof call.provider_call_id==='string'&&!calls.has(call.provider_call_id),'invalid_provider_call');
    calls.set(call.provider_call_id,call);
   }
   const used=new Set(),observedProposals=[];
   for(const execution of runtime.executions){
    const call=calls.get(execution.provider_call_id);
    check(call&&!call.invalid&&!call.provider_executed&&!used.has(call.provider_call_id)&&execution.origin==='eve_tool_execute'&&execution.model_requested===true&&TOOLS.includes(execution.tool),'unproven_model_execution');
    check(call.tool===execution.tool&&call.request_id===execution.request_id&&same(call.arguments,execution.arguments)&&execution.bundle_digest===bundle.digest&&execution.namespace===bundle.namespace,'model_execution_scope_mismatch');
    check(execution.result_digest===rawHash(execution.result),'model_execution_result_mismatch');
    used.add(call.provider_call_id);handlers+=Number(execution.handler_executed===true);
    if(execution.result.proposal){
     const p=execution.result.proposal;
     check(execution.handler_executed===true&&execution.tool==='propose_finding'&&p.execution_mode==='actual_local_inference'&&p.method==='local_agent'&&p.model_requested===true&&p.approval_status==='unapproved'&&p.bundle_digest===bundle.digest&&p.namespace===bundle.namespace,'invalid_model_proposal');
     check(p.runtime_receipt?.provider_call_id===call.provider_call_id&&p.runtime_receipt?.request_id===call.request_id,'model_proposal_receipt_mismatch');
     observedProposals.push(p);
    }
   }
   check(same(runtime.proposals,observedProposals),'model_proposal_execution_mismatch');proposals.push(...observedProposals);
   const decisions=observedProposals.map(p=>verify(p.payload,bundle));
   const emitted=observedProposals.map(p=>({namespace:bundle.namespace,source_id:bundle.source_id,release_id:bundle.evidence[p.payload.after_evidence_id]?.release_id??null,
    before_evidence_id:p.payload.before_evidence_id,after_evidence_id:p.payload.after_evidence_id,kind:p.payload.kind,field:p.payload.field}));
   const grade=gradeFacts(expected,emitted);
   check(same(t.expected_facts,expected)&&same(t.emitted_facts,emitted)&&same(t.grade,grade)&&same(t.verification,decisions),'model_independent_grade_mismatch');
   const previews=observedProposals.flatMap((p,index)=>decisions[index].status==='supported'?[{...renderFinding(p.payload,bundle,decisions[index]),decision:decisions[index],approval_status:'unapproved',published:false}]:[]);
   check(same(t.review_previews,previews)&&t.unsupported_publications===0,'model_publication_mislabelled');
   let outcome=null;
   if(typeof t.reply==='string'&&t.reply.trim())try{const parsed=JSON.parse(t.reply.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));if(OUTCOMES.includes(parsed.outcome))outcome=parsed.outcome;}catch{}
   const inference=localRequests.size>0,correct=inference&&t.status==='completed'&&expected.length===0&&outcome===fixture.truth[i].outcome;
   const support=decisions.filter(d=>d.status==='supported').length;
   check(t.inference_attempted===inference&&t.expected_outcome===fixture.truth[i].outcome&&t.outcome===outcome&&t.correct_noop_or_uncertainty===correct&&t.supported_proposals===support,'model_outcome_mismatch');
   for(const key of ['expected','emitted','matched','missed','duplicates','unsupported'])summary[key]+=grade[key];
   summary.supported_proposals+=support;summary.correct_noop_or_uncertainty+=Number(correct);supported+=support;
   coverage.transitions++;coverage.attempted_transitions+=Number(inference);
   const category=t.expected_outcome==='unchanged_in_observed_scope'?'no_op':t.expected_outcome==='baseline_created'?'baseline':['partial_observation','source_unavailable','unstable_observation','insufficient_evidence'].includes(t.expected_outcome)?'unknown':null;
   if(category){coverage[category].total++;coverage[category].correct+=Number(correct);}
  }
  const inference=requests>0,status=!inference?'unexecuted':row.transitions.every(t=>t.status==='completed')?'completed':'failed';
  check(preparedRequests<=3&&executions<=4,'model_sequence_budget_exceeded');
  check(row.inference_attempted===inference&&row.status===status&&row.model_request_count===requests&&row.model_requested_tool_calls===providerCalls&&row.handler_executions===handlers&&row.quality_available===inference,'model_execution_count_mismatch');
  check(same(row.proposed_findings,proposals)&&row.supported_proposals===(inference?supported:null)&&row.correct_noop_or_uncertainty===(inference?row.transitions.some(t=>t.correct_noop_or_uncertainty):null),'model_row_summary_mismatch');
  attempted+=Number(inference);completed+=Number(status==='completed');failed+=Number(status==='failed');coverage.model_requests+=requests;coverage.provider_tool_calls+=providerCalls;coverage.handler_executions+=handlers;
 }
 check(same(summary,model.summary),'model_summary_mismatch');
 check(model.attempted===attempted&&model.completed===completed&&model.failed===failed&&model.unexecuted===24-attempted&&model.quality_available===(attempted>0),'model_denominator_mismatch');
 const metrics={precision:ratio(summary.matched,summary.emitted,attempted),recall:ratio(summary.matched,summary.expected,attempted),supported_proposals:{value:attempted?summary.supported_proposals:null,unit:'count',state:attempted?'available':'unavailable'}};
 check(same(metrics,model.model_metrics),'model_metric_mismatch');
 const criteria={all_24_attempted:attempted===24,supported_factual_proposal:summary.supported_proposals>=1,correct_noop_or_uncertainty:summary.correct_noop_or_uncertainty>=1,no_unsupported_publications:summary.unsupported_publications===0};
 check(same(criteria,model.demonstration_criteria)&&model.complete_evaluation===(attempted===24&&model.cpu_placement_valid)&&model.demonstration_passed===(Object.values(criteria).every(Boolean)&&model.cpu_placement_valid),'model_criteria_mismatch');
 check(provenance.actual_inference===(attempted>0)&&provenance.runtime_inventory_verified===(attempted>0),'model_runtime_provenance_mismatch');
 return {status:!attempted?'not_executed':!model.cpu_placement_valid?'runtime_invalid':attempted===24?'executed':'partially_executed',summary,coverage,metrics,
  execution_receipt:attempted?{run_id:model.run_id,source_revision:model.source_revision,plan_digest:model.plan_digest,artifact_digest:model.model.artifact_digest,attempted,completed,failed,unexecuted:24-attempted,runtime_inventory_verified:true,cpu_placement_valid:model.cpu_placement_valid}:null};
}
