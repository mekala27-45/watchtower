import { createHash } from 'node:crypto';
export const DISCLAIMER = 'Portfolio demonstration using public release metadata and authored synthetic evaluation cases. Findings describe captured observations within a declared window. They are not security assessments or upgrade recommendations. Agent proposals, deterministic results, recordings and live observations are labeled separately. Incomplete coverage remains unknown.';
export const METHODS = ['deterministic_baseline','local_agent','recorded_local_agent'];
export function canonical(v) {
  if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  if(v===undefined || (typeof v==='number' && !Number.isFinite(v))) throw Error('invalid_canonical_value');
  return JSON.stringify(v);
}
export const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function metric({id,value=null,state='available',category='quality',unit,method,dataset,window,plan_digest,code_revision,evidence,numerator=null,denominator=null}) {
  const m={id,value,state,category,unit,method,dataset,window,plan_digest,code_revision,evidence,numerator,denominator};
  validateMetric(m); return m;
}
export function validateMetric(m) {
  if(!m || !/^[a-z][a-z0-9_.]*$/.test(m.id||'') || !METHODS.includes(m.method)) throw Error('invalid_metric');
  for(const k of ['unit','dataset','window','plan_digest','code_revision','evidence']) if(typeof m[k]!=='string'||!m[k]) throw Error('missing_'+k);
  if(!['available','unavailable','not_applicable'].includes(m.state)) throw Error('invalid_state');
  if(!['execution','quality'].includes(m.category)) throw Error('invalid_category');
  if(m.state!=='available') {if(m.value!==null) throw Error('unavailable_is_not_zero'); return;}
  if(typeof m.value!=='number'||!Number.isFinite(m.value)||m.value<0) throw Error('invalid_value');
  if(m.unit==='ratio') {
    if(!Number.isInteger(m.denominator)||m.denominator<=0||!Number.isInteger(m.numerator)||m.numerator<0||m.numerator>m.denominator||Math.abs(m.value-m.numerator/m.denominator)>1e-12) throw Error('unsupported_ratio');
  }
}
export function sealManifest(data) {
  if(!data || !Array.isArray(data.metrics) || data.metrics.length===0) throw Error('empty_manifest');
  data.metrics.forEach(validateMetric);
  if(new Set(data.metrics.map(m=>m.id)).size!==data.metrics.length) throw Error('duplicate_metric');
  const payload={...data,disclaimer:DISCLAIMER,disclaimer_digest:digest(DISCLAIMER)};
  return validateManifest({...payload,digest:digest(payload)});
}
export function validateManifest(m,revision) {
  if(!m||!m.digest) throw Error('missing_manifest');
  const {digest:expected,...payload}=m;
  if(expected!==digest(payload)) throw Error('manifest_digest_mismatch');
  if(!m.metrics?.length) throw Error('empty_manifest');
  m.metrics.forEach(validateMetric);
  if(!m.code_revision||!m.plan_digest) throw Error('manifest_provenance_required');
  for(const metric of m.metrics) {
    if(metric.code_revision!==m.code_revision||metric.plan_digest!==m.plan_digest) throw Error('metric_provenance_mismatch');
    if(metric.method!=='deterministic_baseline'&&metric.category==='quality'&&metric.state==='available') {
      const run=m.runs?.[metric.method];
      if(!run?.attempted||!run.execution_receipt) throw Error('unexecuted_model_quality');
    }
  }
  if(revision && m.code_revision!==revision) throw Error('stale_report_revision');
  if(m.disclaimer!==DISCLAIMER||m.disclaimer_digest!==digest(DISCLAIMER)) throw Error('disclaimer_mismatch');
  for(const run of Object.values(m.runs||{})) if(run.status==='passed' && (!run.rows||!run.execution_receipt)) throw Error('zero_rows_or_missing_execution');
  return m;
}
export function renderMetric(m) {
  validateMetric(m);
  if(m.state!=='available') return m.state.replaceAll('_',' ');
  return m.unit==='ratio' ? m.numerator+'/'+m.denominator : m.value+' '+m.unit;
}
export function renderTable(manifest,method) {
  validateManifest(manifest);
  if(!METHODS.includes(method)) throw Error('unknown_method');
  const rows=manifest.metrics.filter(m=>m.method===method);
  if(!rows.length) throw Error('empty_method');
  return '| Metric | Result | Dataset | Evidence |\n| --- | --- | --- | --- |\n'+rows.map(m=>'| '+m.id+' | '+renderMetric(m)+' | '+m.dataset+' | '+m.evidence+' |').join('\n');
}
export function renderNumericalSentence(template,metricIds,manifest) {
  validateManifest(manifest);
  if(!template || /\d/.test(template)) throw Error('unbound_number');
  if(!metricIds?.length) throw Error('missing_metric_ids');
  let result=template;
  for(const id of metricIds) {
    const m=manifest.metrics.find(m=>m.id===id);
    if(!m || !result.includes('{'+id+'}')) throw Error('unused_or_missing_metric');
    result=result.replaceAll('{'+id+'}',renderMetric(m));
  }
  if(/\{[^}]+\}/.test(result)) throw Error('unresolved_metric');
  return result;
}
