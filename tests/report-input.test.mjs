import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateReportInputs} from '../packages/reports/input.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function inputs(){
 const baseline=read('reports/baseline/full.json'),subset=read('reports/baseline/model-subset.json'),model=read('reports/model/current.json'),plan=read('docs/evaluation-plan.json');
 baseline.execution.source_revision='test-revision';subset.execution.source_revision='test-revision';model.source_revision='test-revision';
 return {baseline,subset,model,plan,modelArchive:{ledger:structuredClone(model),provenance:{source_revision:'test-revision'}}};
}
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
