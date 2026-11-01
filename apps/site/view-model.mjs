export const SOURCES = ['vercel/eve','ollama/ollama','microsoft/playwright','vitejs/vite'];
export const METHOD_LABELS = Object.freeze({deterministic_baseline:'Deterministic baseline',local_agent:'Actual local model',recorded_local_agent:'Recorded local agent'});
export function methodLabel(method) { return METHOD_LABELS[method] ?? 'Unknown method'; }
export function printable(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function timestamp(value) {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : 'Unavailable';
}
export function shortId(value) { return value ? String(value).slice(0,12) : 'Unrecorded'; }
export function coverageLabel(state) {
  const labels = {captured:'Captured scope',complete:'Captured scope',partial:'Partial',unavailable:'Unavailable',source_unavailable:'Unavailable',unstable:'Unstable',deferred:'Deferred',unknown:'Unknown'};
  return labels[state] ?? 'Unknown';
}
export function metricValue(metric) {
  if (!metric || metric.state === 'unavailable' || metric.state === 'not_applicable' || metric.status === 'unexecuted') return metric?.state === 'not_applicable' ? 'Not applicable' : 'Unavailable';
  if (metric.numerator !== undefined && metric.denominator !== undefined) {
    if (!Number.isFinite(metric.numerator) || !Number.isFinite(metric.denominator) || metric.denominator <= 0) return 'Not applicable';
    return metric.numerator + ' / ' + metric.denominator;
  }
  if (metric.value === null || metric.value === undefined) return 'Unavailable';
  return printable(metric.value) + (metric.unit ? ' ' + metric.unit : '');
}
export function safeSourceUrl(value) {
  try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='github.com' && !url.username && !url.password && SOURCES.some(s=>url.pathname === '/'+s || url.pathname === '/'+s+'/releases' || url.pathname.startsWith('/'+s+'/releases/')) ? url.href : null; } catch { return null; }
}
export function normalizeSources(response) {
  const rows=Array.isArray(response) ? response : response?.sources;
  return SOURCES.map(label => {
    const row=Array.isArray(rows) ? rows.find(x => (x.label ?? x.repository ?? x.name)===label) : null;
    const latest=row?.latestAttempt ?? row?.latest_attempt;
    const head=row?.comparisonHead ?? row?.comparison_head;
    return {...(row ?? {}),label,
      coverage:row?.coverage?.state ?? (typeof row?.coverage==='string'?row.coverage:undefined) ?? latest?.status ?? row?.state ?? 'unknown',
      lastAttempt:row?.lastAttempt ?? latest?.finishedAt ?? latest?.capturedAt ?? latest?.finished_at ?? latest?.captured_at ?? null,
      lastUsableEvidence:row?.lastUsableEvidence ?? head?.capturedAt ?? head?.captured_at ?? null,
      outcome:row?.outcome ?? row?.comparisonOutcome ?? latest?.comparisonOutcome ?? latest?.outcome ?? 'Comparison not recorded',
      window:row?.window ?? latest?.coverage?.window ?? latest?.coverage?.scope ?? null
    };
  });
}
export function modelCaseId(row) { return row?.fixture_id ?? row?.id ?? row?.fixtureId ?? row?.sequenceId ?? 'Unspecified'; }
export function reportMetrics(record) {
  if (!record || typeof record !== 'object') return [];
  if(Array.isArray(record.metrics))return record.metrics;
  if(record.metrics && typeof record.metrics==='object')return Object.entries(record.metrics).map(([id,m])=>({id,...(typeof m==='object'?m:{value:m})}));
  const metrics=[];
  const addCounts=(source,labels,prefix='')=>{
    for(const [key,label] of Object.entries(labels))if(Object.hasOwn(source,key))metrics.push({id:prefix+key,label,value:source[key],unit:'count',state:source[key]===null?'unavailable':'available'});
  };
  addCounts(record,{planned:'Planned cases',attempted:'Actual inference attempts',completed:'Completed cases',unexecuted:'Unexecuted cases'});
  if(record.summary && typeof record.summary==='object'){
    const s=record.summary;
    addCounts(s,{sequences:'Evaluated sequences',transitions:'Observed transitions',expected:'Expected findings',emitted:'Emitted findings',matched:'Matched findings',missed:'Missed findings',duplicates:'Duplicate findings',unsupported:'Unsupported findings',exact_sequences:'Exact sequences',normalization_passed:'Normalization passed'},'summary.');
    for(const key of ['precision','recall'])if(s[key])metrics.push({id:'summary.'+key,label:key[0].toUpperCase()+key.slice(1),...s[key]});
    for(const [key,label] of [['no_op','Correct no-op'],['unknown','Correct unknown'],['baseline','Correct baseline creation']])if(s[key])metrics.push({id:'summary.'+key,label,numerator:s[key].correct,denominator:s[key].total,unit:'ratio'});
    if(s.verifier)addCounts(s.verifier,{supported:'Verifier supported',false_acceptance:'Verifier false acceptance',false_rejection:'Verifier false rejection',forged_challenges:'Forged challenges'},'summary.verifier.');
  }
  if(record.model_metrics && typeof record.model_metrics==='object')for(const [id,metric]of Object.entries(record.model_metrics))metrics.push({id:'model_metrics.'+id,label:id.replaceAll('_',' '),...metric});
  return metrics;
}
export function findingText(finding) {
  const kind=finding.kind ?? finding.findingKind;
  const names={newly_observed_release:'A release identity was newly observed within the captured scope.',tag_changed:'The exact tag string changed between captured revisions.',prerelease_flag_changed:'The captured prerelease flag changed.',asset_metadata_changed:'The captured asset metadata changed.',notes_text_changed:'The captured release-note text digest changed.'};
  return names[kind] ?? 'Typed finding record. Inspect its captured operands.';
}
export function partitionResults(rows=[]) {
  return {baseline:rows.filter(r=>r.method==='deterministic_baseline'),model:rows.filter(r=>r.method==='local_agent'),recorded:rows.filter(r=>r.method==='recorded_local_agent')};
}
export function evidenceFields(value) {
  if(!value || typeof value !== 'object') return [['Evidence','Unavailable']];
  const fields=[['Release identity',value.releaseId ?? value.release_id ?? value.id],['Evidence identity',value.evidenceId],['Exact tag',value.tag ?? value.tagName ?? value.tag_name],['Prerelease flag',value.prerelease],['Notes digest',value.notesDigest ?? value.bodyDigest ?? value.body_digest],['Asset metadata',value.assets],['Observed at',value.observedAt ?? value.observed_at],['Evidence digest',value.digest ?? value.evidenceDigest]];
  return fields.filter(([,v])=>v!==undefined).map(([k,v])=>[k,printable(v)]);
}

