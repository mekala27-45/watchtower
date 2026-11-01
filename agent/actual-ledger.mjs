import {digest,verify,renderFinding} from '../packages/domain/index.mjs';
import {expectedFacts,gradeFacts} from '../packages/domain/grader.mjs';

export function gradeModelTransition(fixture,transition,bundle,runtime,result,error=null){
  const expected=expectedFacts(fixture,transition),proposals=runtime.proposals??[],verification=[],emitted=[],published=[];
  for(const proposal of proposals){
    if(proposal.execution_mode!=='actual_local_inference'||proposal.model_requested!==true)throw new Error('non_model_proposal_in_actual_ledger');
    const decision=verify(proposal.payload,bundle);verification.push(decision);
    const evidence=bundle.evidence[proposal.payload.after_evidence_id];
    emitted.push({namespace:bundle.namespace,source_id:bundle.source_id,release_id:evidence?.release_id??null,
      before_evidence_id:proposal.payload.before_evidence_id,after_evidence_id:proposal.payload.after_evidence_id,
      kind:proposal.payload.kind,field:proposal.payload.field});
    // Render only supported facts as review previews. Human approval/publication is a separate lane.
    if(decision.status==='supported')published.push({...renderFinding(proposal.payload,bundle,decision),decision,approval_status:'unapproved',published:false});
  }
  let outcome=null,reply_error=null;
  if(typeof result?.reply==='string'&&result.reply.trim()){
    try{const parsed=JSON.parse(result.reply.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
      if(['baseline_created','unchanged_in_observed_scope','partial_observation','source_unavailable','unstable_observation','insufficient_evidence'].includes(parsed.outcome))outcome=parsed.outcome;
      else reply_error='invalid_outcome';
    }catch{reply_error='malformed_reply';}
  }
  const grade=gradeFacts(expected,emitted),attempted=runtime.requests.some(r=>r.provider_dispatched===true);
  const correct=attempted&&result?.status==='completed'&&expected.length===0&&outcome===fixture.truth[transition-1].outcome;
  return {transition,method:'local_agent',inference_attempted:attempted,bundle,bundle_digest:bundle.digest,
    expected_outcome:fixture.truth[transition-1].outcome,outcome,expected_facts:expected,emitted_facts:emitted,grade,
    verification,review_previews:published,unsupported_publications:0,correct_noop_or_uncertainty:correct,
    supported_proposals:verification.filter(v=>v.status==='supported').length,
    status:error?'failed':result?.status??'unexecuted',error,reply:result?.reply??null,reply_error,runtime};
}

export function buildActualLedger({plan,manifest,rows,sourceRevision,model,probeArtifact,runId,development=false}){
  if(!development&&(rows.length!==24||JSON.stringify(rows.map(r=>r.fixture_id))!==JSON.stringify(plan.subset_ids)))throw new Error('actual_subset_mismatch');
  if(!development&&JSON.stringify(manifest.modelSubsetIds)!==JSON.stringify(plan.subset_ids))throw new Error('manifest_subset_mismatch');
  const attempted=rows.filter(r=>r.inference_attempted).length,completed=rows.filter(r=>r.status==='completed').length;
  const summary={expected:0,emitted:0,matched:0,missed:0,duplicates:0,unsupported:0,supported_proposals:0,correct_noop_or_uncertainty:0,unsupported_publications:0};
  for(const row of rows)for(const t of row.transitions){for(const key of ['expected','emitted','matched','missed','duplicates','unsupported'])summary[key]+=t.grade[key];summary.supported_proposals+=t.supported_proposals;summary.correct_noop_or_uncertainty+=Number(t.correct_noop_or_uncertainty);summary.unsupported_publications+=t.unsupported_publications;}
  const metric=(numerator,denominator)=>({value:attempted&&denominator?numerator/denominator:null,numerator:attempted?numerator:null,denominator:attempted?denominator:null,unit:'ratio',state:!attempted?'unavailable':denominator?'available':'not_applicable'});
  const criteria={all_24_attempted:!development&&attempted===24,supported_factual_proposal:summary.supported_proposals>=1,
    correct_noop_or_uncertainty:summary.correct_noop_or_uncertainty>=1,no_unsupported_publications:summary.unsupported_publications===0};
  return {schema:'watchtower-model-ledger-v1',method:'local_agent',execution_mode:'actual_local_inference',namespace:'evaluation',
    dataset:development?'authored_temporal_development_probe':'authored_temporal_heldout_subset',run_id:runId,
    plan_digest:plan.plan_digest,source_revision:sourceRevision,subset_ids:rows.map(r=>r.fixture_id),subset_digest:digest(rows.map(r=>r.fixture_id)),fixture_digest:manifest.fixture_digest,
    model,probe_artifact:probeArtifact,baseline_comparison_artifact:development?null:'reports/baseline/model-subset.json',
    complete_evaluation:!development&&attempted===24,planned:rows.length,attempted,completed,failed:rows.filter(r=>r.status==='failed').length,
    unexecuted:rows.length-attempted,quality_available:attempted>0,summary,
    model_metrics:{precision:metric(summary.matched,summary.emitted),recall:metric(summary.matched,summary.expected),
      supported_proposals:{value:attempted?summary.supported_proposals:null,unit:'count',state:attempted?'available':'unavailable'}},
    demonstration_criteria:criteria,demonstration_passed:Object.values(criteria).every(Boolean),rows,
    limitations:['Authored synthetic fixtures; these are model proposals and independently verified review previews, not human approvals or public publications.','Failures and unexecuted transitions stay in the registered denominator; no retries or heldout tuning.']};
}
