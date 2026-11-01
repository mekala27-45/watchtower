import test from 'node:test';
import assert from 'node:assert/strict';
import {metric,sealManifest,validateManifest,renderMetric,renderNumericalSentence,renderTable} from '../packages/reports/index.mjs';
const base={id:'baseline.rows',value:2,unit:'sequences',method:'deterministic_baseline',dataset:'authored',window:'frozen',plan_digest:'abc',code_revision:'rev',evidence:'reports/test.json'};
test('report gate accepts admitted metric with evidence',()=>{
 const m=sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric(base)]});
 assert.equal(renderNumericalSentence('Observed {baseline.rows}.',['baseline.rows'],m),'Observed 2 sequences.');
 assert.match(renderTable(m,'deterministic_baseline'),/2 sequences/);
});
test('report gate refuses tampering, stale revision and unbound numbers',()=>{
 const m=sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric(base)]});
 assert.throws(()=>validateManifest({...m,code_revision:'wrong'}),/digest/);
 assert.throws(()=>validateManifest(m,'later'),/stale/);
 assert.throws(()=>renderNumericalSentence('Observed 99 rows.',['baseline.rows'],m),/unbound/);
 assert.throws(()=>metric({...base,unit:'ratio',value:1,numerator:0,denominator:0}),/ratio/);
 assert.throws(()=>sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric(base)],runs:{baseline:{status:'passed',rows:0}}}),/zero_rows/);
});
test('report gate refuses empty input and preserves unavailable',()=>{
 assert.throws(()=>sealManifest({metrics:[]}),/empty/);
 assert.throws(()=>validateManifest(null),/missing/);
 assert.throws(()=>renderTable(sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric(base)]}),'local_agent'),/empty_method/);
 assert.equal(renderMetric(metric({...base,id:'model.quality',method:'local_agent',state:'unavailable',value:null})),'unavailable');
 assert.throws(()=>metric({...base,state:'unavailable',value:0}),/not_zero/);
});
test('report gate binds every metric to one plan and rejects fabricated model quality',()=>{
 assert.throws(()=>sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric({...base,plan_digest:'other'})]}),/provenance_mismatch/);
 assert.throws(()=>sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric({...base,method:'local_agent'})],runs:{local_agent:{status:'not_executed',rows:0,attempted:0}}}),/unexecuted_model_quality/);
 const report=sealManifest({code_revision:'rev',plan_digest:'abc',metrics:[metric({...base,id:'model.attempts',category:'execution',method:'local_agent',value:0})],runs:{local_agent:{status:'not_executed',rows:0,attempted:0}}});
 assert.match(renderTable(report,'local_agent'),/0 sequences/);
});
