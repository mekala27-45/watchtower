import {createHash} from 'node:crypto';

// The grader reads authored truth and never calls detect, verify or normalizeRelease.
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?
  '['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function referenceEvidence(raw,namespace,sourceId){
  const fields={namespace,source_id:sourceId,release_id:raw.id,tag_name:raw.tag_name,draft:raw.draft,prerelease:raw.prerelease,
    created_at:new Date(raw.created_at).toISOString(),published_at:raw.published_at===null?null:new Date(raw.published_at).toISOString(),
    assets:raw.assets.map(a=>({id:a.id,name:a.name,size:a.size,content_type:a.content_type})).sort((a,b)=>a.id-b.id),
    notes_digest:createHash('sha256').update(raw.body??'').digest('hex'),notes_bytes:Buffer.byteLength(raw.body??''),normalizer_version:'normalizer-v1'};
  const digest=hash(fields);return {...fields,digest,id:'ev_'+digest};
}
export function expectedFacts(fixture,transition){
  const truth=fixture.truth[transition-1];let prior=fixture.observations[0];
  for(let i=1;i<transition;i++)if(fixture.observations[i]?.state==='captured'&&!fixture.observations[i].expected_rejection)prior=fixture.observations[i];
  const before=(prior?.raw_items??[]).map(r=>referenceEvidence(r,fixture.namespace,fixture.source_id));
  const after=truth.expected_normalized??[];
  return truth.findings.map(f=>{
    const old=before.find(e=>e.release_id===f.release_id),current=after.find(e=>e.release_id===f.release_id);
    if(!current)throw new Error('truth_missing_after_revision');
    return {namespace:fixture.namespace,source_id:fixture.source_id,release_id:f.release_id,
      before_evidence_id:f.kind==='newly_observed_release'?null:old?.id??null,after_evidence_id:current.id,kind:f.kind,field:f.field};
  });
}
export function exactKey(fact){
  if(!fact||typeof fact!=='object')return '!invalid';
  return canonical({namespace:fact.namespace,source_id:fact.source_id,release_id:fact.release_id,
    before_evidence_id:fact.before_evidence_id,after_evidence_id:fact.after_evidence_id,kind:fact.kind,field:fact.field});
}
export function gradeFacts(expected,emitted){
  if(!Array.isArray(expected)||!Array.isArray(emitted))throw new Error('invalid_grading_input');
  const expectedKeys=new Set(expected.map(exactKey)),seen=new Set();
  let matched=0,duplicates=0,unsupported=0;
  for(const fact of emitted){
    const key=exactKey(fact);
    if(seen.has(key)){duplicates++;continue;}seen.add(key);
    if(expectedKeys.has(key))matched++;else unsupported++;
  }
  const missed=expectedKeys.size-matched;
  return {expected:expectedKeys.size,emitted:emitted.length,matched,missed,duplicates,unsupported,
    precision:{value:emitted.length?matched/emitted.length:null,numerator:matched,denominator:emitted.length,unit:'ratio',state:emitted.length?'available':'not_applicable'},
    recall:{value:expectedKeys.size?matched/expectedKeys.size:null,numerator:matched,denominator:expectedKeys.size,unit:'ratio',state:expectedKeys.size?'available':'not_applicable'},
    pass:missed===0&&unsupported===0&&duplicates===0};
}
export function summarizeRows(rows){
  if(!Array.isArray(rows)||rows.length===0)throw new Error('empty_results');
  const aggregate={sequences:rows.length,transitions:0,expected:0,emitted:0,matched:0,missed:0,duplicates:0,unsupported:0,
    exact_sequences:0,normalization_passed:0,no_op:{correct:0,total:0},unknown:{correct:0,total:0},baseline:{correct:0,total:0},
    verifier:{supported:0,false_acceptance:0,false_rejection:0,forged_challenges:0}};
  for(const row of rows){
    if(row.method!=='deterministic_baseline')throw new Error('mixed_method_results');
    if(row.pass)aggregate.exact_sequences++;
    if(row.normalization_passed)aggregate.normalization_passed++;
    for(const result of row.transitions){
      aggregate.transitions++;
      for(const key of ['expected','emitted','matched','missed','duplicates','unsupported'])aggregate[key]+=result.grade[key];
      const type=result.expected_outcome==='unchanged_in_observed_scope'?'no_op':result.expected_outcome==='baseline_created'?'baseline':
        ['partial_observation','source_unavailable','unstable_observation','insufficient_evidence'].includes(result.expected_outcome)?'unknown':null;
      if(type){aggregate[type].total++;if(result.outcome===result.expected_outcome)aggregate[type].correct++;}
      aggregate.verifier.supported+=result.verification.filter(v=>v.status==='supported').length;
      aggregate.verifier.false_rejection+=result.verification.filter(v=>v.status!=='supported').length;
      aggregate.verifier.forged_challenges+=result.forged_decisions.length;
      aggregate.verifier.false_acceptance+=result.forged_decisions.filter(v=>v.status==='supported').length;
    }
  }
  aggregate.precision={value:aggregate.emitted?aggregate.matched/aggregate.emitted:null,numerator:aggregate.matched,denominator:aggregate.emitted,unit:'ratio',state:aggregate.emitted?'available':'not_applicable'};
  aggregate.recall={value:aggregate.expected?aggregate.matched/aggregate.expected:null,numerator:aggregate.matched,denominator:aggregate.expected,unit:'ratio',state:aggregate.expected?'available':'not_applicable'};
  return aggregate;
}

