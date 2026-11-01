import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {digest,normalizeRelease,makeObservation,makeBundle,baseline,verify} from '../packages/domain/index.mjs';
import {expectedFacts,gradeFacts,summarizeRows} from '../packages/domain/grader.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const manifest=read('fixtures/manifest.json'),plan=read('docs/evaluation-plan.json');
const{plan_digest,...planPayload}=plan;if(digest(planPayload)!==plan_digest)throw new Error('plan_digest_mismatch');
const source_revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const committed=execFileSync('git',['show','HEAD:docs/evaluation-plan.json'],{cwd:root,encoding:'utf8'});
if(digest(JSON.parse(committed))!==digest(plan))throw new Error('plan_not_committed');
const all=manifest.developmentIds.map(id=>read('fixtures/development/'+id+'.json')).concat(manifest.heldoutIds.map(id=>read('fixtures/heldout/'+id+'.json'))).sort((a,b)=>a.id.localeCompare(b.id));
if(digest(all)!==plan.dataset_digest||manifest.fixture_digest!==plan.dataset_digest)throw new Error('fixture_digest_mismatch');
const normalized=(fixture,observation)=>makeObservation({namespace:fixture.namespace,sourceId:fixture.source_id,state:observation.state,
  scope:observation.scope,items:observation.raw_items.map(r=>normalizeRelease(r,{namespace:fixture.namespace,sourceId:fixture.source_id})),
  coverage:{procedure_complete:observation.state==='captured',uncovered_scope:observation.uncovered_scope??(observation.state==='captured'?[]:['incomplete_observation'])}});
const runStarted=new Date().toISOString(),start=performance.now();
const rows=[];
for(const id of manifest.heldoutIds){
  const fixture=all.find(f=>f.id===id);
  let comparison=fixture.observations[0]?normalized(fixture,fixture.observations[0]):null;
  const transitions=[];let normalization_passed=true;
  for(let i=1;i<fixture.observations.length;i++){
    const authored=fixture.observations[i],truth=fixture.truth[i-1],expected=expectedFacts(fixture,i),receipts=[];
    let outcome,emitted=[],verification=[],forged_decisions=[],normalization_error=null;
    try{
      const observation=normalized(fixture,authored);
      receipts.push({stage:'normalization',receipt:digest({fixture_id:id,transition:i,observation_digest:observation.digest})});
      const normalizedExpected=truth.expected_normalized;
      if(!normalizedExpected||digest(observation.items)!==digest(normalizedExpected))normalization_passed=false;
      const bundle=makeBundle(comparison,observation,{watchlistVersion:'watchlist-v1'});
      const result=baseline(bundle);outcome=result.outcome;
      receipts.push({stage:'detection',receipt:digest({fixture_id:id,transition:i,bundle_digest:bundle.digest})});
      for(const proposal of result.proposals){
        const decision=verify(proposal,bundle);verification.push(decision);
        const after=bundle.evidence[proposal.after_evidence_id];
        emitted.push({namespace:fixture.namespace,source_id:fixture.source_id,release_id:after.release_id,
          before_evidence_id:proposal.before_evidence_id,after_evidence_id:proposal.after_evidence_id,kind:proposal.kind,field:proposal.field});
        const forgeries=[
          {...proposal,candidate_id:'forged-candidate'},
          {...proposal,after_evidence_id:'ev_'+'0'.repeat(64)},
          {...proposal,before_evidence_id:proposal.after_evidence_id},
          {...proposal,field:'upgrade_safety'},
          {...proposal,approved:true}
        ];
        for(const forged of forgeries)forged_decisions.push(verify(forged,bundle));
      }
      receipts.push({stage:'verification',receipt:digest({fixture_id:id,transition:i,decisions:verification,forged_decisions})});
      if(observation.state==='captured')comparison=observation;
    }catch(error){
      normalization_error=error.code??error.message;outcome='insufficient_evidence';
      if(!authored.expected_rejection||normalization_error!==authored.expected_rejection)normalization_passed=false;
      receipts.push({stage:'normalization_refusal',receipt:digest({fixture_id:id,transition:i,normalization_error})});
    }
    const grade=gradeFacts(expected,emitted);
    transitions.push({transition:i,expected_outcome:truth.outcome,outcome,expected_facts:expected,emitted_facts:emitted,
      grade,verification,forged_decisions,normalization_error,execution_receipts:receipts,
      pass:grade.pass&&outcome===truth.outcome&&verification.every(d=>d.status==='supported')&&forged_decisions.every(d=>d.status!=='supported')});
  }
  rows.push({id,family:fixture.family,lineage:fixture.lineage,method:'deterministic_baseline',plan_digest,
    normalization_passed,transitions,pass:normalization_passed&&transitions.every(t=>t.pass)});
}
const runtime_ms=performance.now()-start;
const receipt={run_started:runStarted,run_finished:new Date().toISOString(),elapsed_ms:runtime_ms,source_revision,plan_digest,
  executed_stages:['normalization','detection','verification'],not_executed_stages:['live_collection','model_inference','human_review','publication'],
  mode:'authored_synthetic',runtime:process.version};
mkdirSync(resolve(root,'reports/baseline'),{recursive:true});
for(const[name,selected]of[['full',rows],['model-subset',rows.filter(r=>manifest.modelSubsetIds.includes(r.id))]]){
  const stable={method:'deterministic_baseline',dataset:name==='full'?'heldout_full':'registered_model_subset',plan_digest,
    dataset_digest:plan.dataset_digest,subset_ids:selected.map(r=>r.id),summary:summarizeRows(selected),rows:selected};
  const report={...stable,stable_digest:digest(stable),execution:receipt};
  writeFileSync(resolve(root,'reports/baseline/'+name+'.json'),JSON.stringify(report,null,2)+'\n');
}
const failed=rows.filter(r=>!r.pass);
console.log(JSON.stringify({plan_digest,source_revision,summary:summarizeRows(rows),failed_ids:failed.map(r=>r.id)},null,2));
if(failed.length)process.exitCode=1;

