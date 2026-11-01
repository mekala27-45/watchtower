import {digest,canonical} from './index.mjs';
import {summarizeRows} from '../domain/grader.mjs';
import {validateActualModel} from './model-input.mjs';
export function validateReportInputs({baseline,subset,model,plan,modelArchive,fixtures},revision) {
 if(!baseline||!subset||!model||!plan||!modelArchive)throw Error('missing_report_inputs');
 const {plan_digest,...planBody}=plan;
 if(digest(planBody)!==plan_digest)throw Error('invalid_plan_digest');
 for(const report of [baseline,subset]){
  const {stable_digest,execution,...stable}=report;
  if(digest(stable)!==stable_digest)throw Error('input_digest_mismatch');
  if(report.plan_digest!==plan_digest||execution?.plan_digest!==plan_digest||report.dataset_digest!==plan.dataset_digest)throw Error('input_plan_mismatch');
  if(!report.rows?.length||!execution?.run_started||!execution.run_finished||!execution.executed_stages?.includes('verification'))throw Error('missing_execution_record');
  if(execution.source_revision!==revision)throw Error('stale_input_revision');
  if(canonical(summarizeRows(report.rows))!==canonical(report.summary))throw Error('invalid_summary');
  if(report.rows.some(r=>r.method!=='deterministic_baseline'||r.plan_digest!==plan_digest||!r.pass||!r.transitions?.length))throw Error('baseline_gate_failed');
  if(report.rows.some(r=>r.transitions.some(t=>!t.pass||!t.execution_receipts?.length)))throw Error('missing_stage_receipt');
 }
 if(baseline.rows.length!==72||subset.rows.length!==24)throw Error('incomplete_baseline_denominator');
 const ids=rows=>rows.map(r=>r.id??r.fixture_id).sort();
 const expected=[...plan.subset_ids].sort();
 if(canonical(ids(subset.rows))!==canonical(expected)||canonical(ids(model.rows||[]))!==canonical(expected))throw Error('input_subset_mismatch');
 if(model.plan_digest!==plan_digest||model.fixture_digest!==plan.dataset_digest||model.source_revision!==revision)throw Error('model_provenance_mismatch');
 if(canonical(modelArchive.ledger)!==canonical(model)||modelArchive.provenance?.source_revision!==revision)throw Error('model_archive_mismatch');
 if(model.execution_mode==='actual_local_inference'){
  const actual=validateActualModel({model,plan,modelArchive,fixtures});
  return {baseline_status:'passed',baseline_execution:baseline.execution,model_status:actual.status,model_execution:actual.execution_receipt,model_summary:actual.summary,model_coverage:actual.coverage,model_metrics:actual.metrics};
 }
 if(model.execution_mode!=='actual_inference_unavailable')throw Error('unrecognized_model_execution_mode');
 if(model.attempted!==0||model.completed!==0||model.unexecuted!==24||model.planned!==24||model.quality_available!==false)throw Error('actual_model_input_not_supported');
 if(model.rows.some(r=>r.method!=='local_agent'||r.status!=='unexecuted'||r.inference_attempted||r.handler_executions!==0||r.precision!==null||r.recall!==null||r.supported_proposals!==null))throw Error('invalid_unexecuted_model_row');
 return {baseline_status:'passed',baseline_execution:baseline.execution,model_status:'not_executed',model_execution:null,model_summary:null,model_coverage:null,model_metrics:model.model_metrics};
}
