import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {methodLabel,printable,timestamp,coverageLabel,metricValue,safeSourceUrl,normalizeSources,partitionResults,evidenceFields,modelCaseId,reportMetrics} from '../apps/site/view-model.mjs';
import {Store} from '../packages/workflow/store.mjs';

test('unavailable evidence never renders as zero or a successful negative',()=>{
 assert.equal(printable(undefined),'Unavailable');assert.equal(printable(null),'Unavailable');
 assert.equal(printable(0),'0');assert.equal(coverageLabel(undefined),'Unknown');
 assert.equal(timestamp(null),'Not observed');assert.equal(timestamp('malformed'),'Unavailable');
 const rows=normalizeSources({sources:[{label:'vercel/eve',coverage:'unavailable'}]});
 assert.equal(rows.length,4);assert.equal(rows[0].coverage,'unavailable');assert.equal(rows[1].coverage,'unknown');
});
test('ratios retain denominator and refuse missing, empty and impossible values',()=>{
 assert.equal(metricValue({numerator:3,denominator:4}),'3 / 4');
 assert.equal(metricValue({numerator:0,denominator:0}),'Not applicable');
 assert.equal(metricValue({numerator:NaN,denominator:4}),'Not applicable');
 assert.equal(metricValue({state:'unavailable',value:0}),'Unavailable');
 assert.equal(metricValue(null),'Unavailable');
});
test('baseline, actual inference and recorded inference remain separate',()=>{
 const rows=[{method:'deterministic_baseline',id:'b'},{method:'local_agent',id:'m'},{method:'recorded_local_agent',id:'r'},{method:'unknown',id:'u'}];
 assert.deepEqual(partitionResults(rows),{baseline:[rows[0]],model:[rows[1]],recorded:[rows[2]]});
 assert.equal(methodLabel('local_agent'),'Actual local model');
 assert.equal(methodLabel('recorded_local_agent'),'Recorded local agent');
 assert.equal(methodLabel(undefined),'Unknown method');
});
test('links admit allowlisted GitHub release locations only',()=>{
 assert.equal(safeSourceUrl('https://github.com/vercel/eve/releases/tag/v1'),'https://github.com/vercel/eve/releases/tag/v1');
 for(const value of ['javascript:alert(1)','https://github.com.evil.test/vercel/eve/releases','https://evil.test/','https://github.com/other/repo/releases','https://github.com/vercel/eve/releases-forged','https://user:pass@github.com/vercel/eve/releases','',undefined]) assert.equal(safeSourceUrl(value),null);
});
test('before and after evidence fields retain false booleans and hostile metadata as text',()=>{
 const fields=evidenceFields({tag:'<script>alert(1)</script>',prerelease:false,assets:[]});
 assert.deepEqual(fields,[['Exact tag','<script>alert(1)</script>'],['Prerelease flag','false'],['Asset metadata','[]']]);
 assert.deepEqual(evidenceFields(null),[['Evidence','Unavailable']]);
 const app=readFileSync(new URL('../apps/site/app.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(app,/\.innerHTML\s*=|insertAdjacentHTML|eval\s*\(/);
 assert.match(app,/node\.textContent=text/);
 assert.doesNotMatch(app,/localStorage|sessionStorage/);
});
test('UI shell exposes readable states and keyboard affordances without success placeholders',()=>{
 const html=readFileSync(new URL('../apps/site/index.html',import.meta.url),'utf8');
 const css=readFileSync(new URL('../apps/site/styles.css',import.meta.url),'utf8');
 for(const id of ['view-sources','view-briefings','view-trace','view-evidence','approve','publish','recover','briefing-digest','receipt','theme-toggle'])assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(html,/href="#main"/);assert.match(html,/aria-live="polite"/);assert.match(html,/scope="col"/);
 assert.match(css,/:focus-visible/);assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/@media\(max-width:600px\)/);
 assert.match(html,/font files have not been installed or license-verified/);
 assert.match(html,/Public deployment: not verified/);
});
test('exact palette retains the requested magnitude ramps and text contrast',()=>{
 const palette=JSON.parse(readFileSync(new URL('../palette.json',import.meta.url),'utf8'));
 const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(values[0]+.05)/(values[1]+.05);};
 assert.equal(palette.light.surface,'#F4F6F1');assert.equal(palette.dark.surface,'#213329');
 for(const theme of Object.values(palette)){assert.deepEqual(theme.ordinal,theme.sequential);assert.equal(theme.categorical.length,8);assert.equal(theme.diverging.length,9);assert.ok(contrast(theme.ink,theme.surface)>7);assert.ok(contrast(theme.ink2,theme.surface)>4.5);for(const key of ['good','warning','serious','critical'])assert.ok(contrast(theme[key],theme.surface)>4.5);}
});

test('source view consumes the real store shape and preserves failed attempt versus usable head',()=>{
 const store=new Store(':memory:');
 try {
  store.registerSource('test:ui',23,'vercel/eve');
  let lease=store.acquireLease('test:ui',23,'ui-clean');
  store.recordObservation({namespace:'test:ui',sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true,scope:'authored UI fixture'},evidence:[{itemId:1,tag:'v1'}],runId:'usable'});
  const captured=store.listSources('test:ui')[0];
  const clean=normalizeSources({sources:[captured]})[0];
  assert.equal(clean.coverage,'captured');
  assert.equal(clean.lastAttempt,captured.latestAttempt.capturedAt);
  assert.equal(clean.lastUsableEvidence,captured.comparisonHead.capturedAt);
  assert.notEqual(timestamp(clean.lastAttempt),'Not observed');
  lease=store.acquireLease('test:ui',23,'ui-failure');
  store.recordObservation({namespace:'test:ui',sourceId:23,lease,expectedHead:lease.expectedHead,status:'unavailable',coverage:{complete:false,reason:'timeout'},evidence:[],runId:'failed'});
  const failed=store.listSources('test:ui')[0];
  const result=normalizeSources({sources:[failed]})[0];
  assert.equal(result.coverage,'unavailable');
  assert.equal(result.lastAttempt,failed.latestAttempt.capturedAt);
  assert.equal(result.lastUsableEvidence,captured.comparisonHead.capturedAt);
  assert.equal(result.comparisonHead.runId,'usable');
  assert.equal(result.latestAttempt.runId,'failed');
  assert.notEqual(result.outcome,'unchanged');
 } finally {store.close();}
});

test('actual generated model rows retain every fixture identity and unavailable quality',()=>{
 const model=JSON.parse(readFileSync(new URL('../reports/model/current.json',import.meta.url),'utf8'));
 assert.deepEqual(model.rows.map(modelCaseId),model.subset_ids);
 assert.ok(model.rows.every(row=>modelCaseId(row)!=='Unspecified'));
 const metrics=reportMetrics(model);
 assert.equal(metrics.find(m=>m.id==='attempted').value,model.attempted);
 assert.equal(metrics.find(m=>m.id==='unexecuted').value,model.unexecuted);
 assert.equal(metricValue(metrics.find(m=>m.id==='model_metrics.precision')),'Unavailable');
 assert.equal(metricValue(metrics.find(m=>m.id==='model_metrics.supported_proposals')),'Unavailable');
});

test('actual baseline summary is rendered with its denominators and independent verifier counts',()=>{
 const baseline=JSON.parse(readFileSync(new URL('../reports/baseline/full.json',import.meta.url),'utf8'));
 const metrics=reportMetrics(baseline);
 assert.equal(metrics.find(m=>m.id==='summary.sequences').value,baseline.summary.sequences);
 assert.equal(metrics.find(m=>m.id==='summary.matched').value,baseline.summary.matched);
 assert.equal(metricValue(metrics.find(m=>m.id==='summary.recall')),baseline.summary.recall.numerator+' / '+baseline.summary.recall.denominator);
 assert.equal(metricValue(metrics.find(m=>m.id==='summary.unknown')),baseline.summary.unknown.correct+' / '+baseline.summary.unknown.total);
 assert.equal(metrics.find(m=>m.id==='summary.verifier.false_acceptance').value,baseline.summary.verifier.false_acceptance);
 assert.deepEqual(reportMetrics(null),[]);
 const subset=JSON.parse(readFileSync(new URL('../reports/baseline/model-subset.json',import.meta.url),'utf8'));
 const model=JSON.parse(readFileSync(new URL('../reports/model/current.json',import.meta.url),'utf8'));
 assert.deepEqual(subset.subset_ids,model.subset_ids);
 assert.equal(reportMetrics(subset).find(m=>m.id==='summary.sequences').value,model.planned);
 const html=readFileSync(new URL('../apps/site/index.html',import.meta.url),'utf8');
 assert.match(html,/id="baseline-subset-results"/);assert.match(html,/Full held-out deterministic baseline/);
});

