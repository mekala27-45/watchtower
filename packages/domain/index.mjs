import { createHash } from 'node:crypto';

export const NORMALIZER_VERSION = 'normalizer-v1';
export const VERIFIER_VERSION = 'verifier-v1';
export const FINDING_FIELDS = Object.freeze({
  newly_observed_release: 'identity', tag_changed: 'tag_name', prerelease_flag_changed: 'prerelease',
  asset_metadata_changed: 'assets', notes_text_changed: 'notes_digest'
});
export const METHODS = Object.freeze(['deterministic_baseline', 'local_agent', 'recorded_local_agent']);
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw new Error('unsupported_canonical_value');
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function textDigest(text) { return createHash('sha256').update(text).digest('hex'); }
function fail(code) { throw Object.assign(new Error(code), {code}); }
function boundedText(value,max,code,{empty=false}={}) {
  if(typeof value!=='string'||(!empty&&!value.length)||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/u.test(value))fail(code);
  return value;
}
function positive(value,code){if(!Number.isSafeInteger(value)||value<=0)fail(code);return value;}
function date(value,code,{nullable=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||!/[Tt].*([Zz]|[+-]\d\d:\d\d)$/.test(value))fail(code);
  return new Date(value).toISOString();
}
export function normalizeRelease(raw,{namespace,sourceId}={}) {
  if(!raw||Array.isArray(raw)||typeof raw!=='object')fail('invalid_release');
  boundedText(namespace,128,'invalid_namespace');positive(sourceId,'invalid_source_id');
  const release_id=positive(raw.id,'invalid_release_id');
  const tag_name=boundedText(raw.tag_name,512,'invalid_tag_name');
  if(typeof raw.draft!=='boolean')fail('invalid_draft');
  if(typeof raw.prerelease!=='boolean')fail('invalid_prerelease');
  if(!Array.isArray(raw.assets)||raw.assets.length>100)fail('invalid_assets');
  const assetIds=new Set();
  const assets=raw.assets.map(asset=>{
    if(!asset||typeof asset!=='object')fail('invalid_asset');
    const id=positive(asset.id,'invalid_asset_id');if(assetIds.has(id))fail('duplicate_asset_id');assetIds.add(id);
    if(!Number.isSafeInteger(asset.size)||asset.size<0)fail('invalid_asset_size');
    return {id,name:boundedText(asset.name,512,'invalid_asset_name'),size:asset.size,
      content_type:boundedText(asset.content_type,128,'invalid_asset_content_type')};
  }).sort((a,b)=>a.id-b.id);
  const body=raw.body===null||raw.body===undefined?'':raw.body;
  if(typeof body!=='string'||Buffer.byteLength(body)>262144)fail('invalid_body');
  const fields={namespace,source_id:sourceId,release_id,tag_name,draft:raw.draft,prerelease:raw.prerelease,
    published_at:date(raw.published_at,'invalid_published_at',{nullable:true}),created_at:date(raw.created_at,'invalid_created_at'),
    assets,notes_digest:textDigest(body),notes_bytes:Buffer.byteLength(body),normalizer_version:NORMALIZER_VERSION};
  const d=digest(fields);return {...fields,digest:d,id:'ev_'+d};
}
export function validateEvidence(evidence) {
  if(!evidence||typeof evidence!=='object')return false;
  const {id,digest:declared,...fields}=evidence;
  try{
    const keys=['namespace','source_id','release_id','tag_name','draft','prerelease','published_at','created_at','assets','notes_digest','notes_bytes','normalizer_version'];
    if(Object.keys(fields).length!==keys.length||Object.keys(fields).some(k=>!keys.includes(k)))return false;
    boundedText(fields.namespace,128,'invalid_namespace');positive(fields.source_id,'invalid_source_id');positive(fields.release_id,'invalid_release_id');
    boundedText(fields.tag_name,512,'invalid_tag_name');
    if(typeof fields.draft!=='boolean'||typeof fields.prerelease!=='boolean'||!Number.isSafeInteger(fields.notes_bytes)||fields.notes_bytes<0||fields.notes_bytes>262144||!/^([a-f0-9]{64})$/.test(fields.notes_digest))return false;
    if(date(fields.created_at,'invalid_created_at')!==fields.created_at||date(fields.published_at,'invalid_published_at',{nullable:true})!==fields.published_at)return false;
    if(!Array.isArray(fields.assets)||fields.assets.length>100)return false;
    let previous=0;
    for(const asset of fields.assets){
      if(Object.keys(asset).sort().join(',')!=='content_type,id,name,size')return false;
      positive(asset.id,'invalid_asset_id');if(asset.id<=previous)return false;previous=asset.id;
      boundedText(asset.name,512,'invalid_asset_name');boundedText(asset.content_type,128,'invalid_asset_content_type');
      if(!Number.isSafeInteger(asset.size)||asset.size<0)return false;
    }
    return declared===digest(fields)&&id==='ev_'+declared&&fields.normalizer_version===NORMALIZER_VERSION;
  }catch{return false;}
}
export function makeObservation({namespace,sourceId,items,state='captured',scope='bounded-v1',coverage=null,captured_at=null,checked_at=null}={}) {
  boundedText(namespace,128,'invalid_namespace');positive(sourceId,'invalid_source_id');
  if(!['captured','partial','unavailable','unstable','deferred'].includes(state))fail('invalid_observation_state');
  if(!Array.isArray(items)||items.length>100)fail('invalid_observation_items');
  boundedText(scope,128,'invalid_scope');
  const unique=new Map();let conflict=false;
  for(const item of items){
    if(!validateEvidence(item)||item.namespace!==namespace||item.source_id!==sourceId)fail('invalid_observation_evidence');
    if(unique.has(item.release_id)&&unique.get(item.release_id).digest!==item.digest)conflict=true;
    unique.set(item.release_id,item);
  }
  const resolvedState=conflict?'unstable':state;
  const coverageFields={...(coverage??{}),procedure_complete:resolvedState==='captured'};
  if(resolvedState!=='captured'&&(!coverageFields.uncovered_scope||Array.isArray(coverageFields.uncovered_scope)&&coverageFields.uncovered_scope.length===0))coverageFields.uncovered_scope=['incomplete_observation'];
  if(coverageFields.uncovered_scope===undefined)coverageFields.uncovered_scope=[];
  const fields={namespace,source_id:sourceId,items:[...unique.values()].sort((a,b)=>a.release_id-b.release_id),
    state:resolvedState,scope,coverage:coverageFields};
  const d=digest(fields);return {...fields,id:'obs_'+d,digest:d,captured_at,checked_at};
}
function observationValid(observation){
  if(!observation)return false;
  const {id,digest:declared,captured_at,checked_at,...fields}=observation;
  try{
    boundedText(fields.namespace,128,'invalid_namespace');positive(fields.source_id,'invalid_source_id');boundedText(fields.scope,128,'invalid_scope');
    if(!['captured','partial','unavailable','unstable','deferred'].includes(fields.state)||!Array.isArray(fields.items)||fields.items.length>100)return false;
    if(!fields.coverage||fields.coverage.procedure_complete!==(fields.state==='captured'))return false;
    if(fields.state!=='captured'&&(!fields.coverage.uncovered_scope||Array.isArray(fields.coverage.uncovered_scope)&&fields.coverage.uncovered_scope.length===0))return false;
    let previous=0;
    for(const item of fields.items){if(!validateEvidence(item)||item.namespace!==fields.namespace||item.source_id!==fields.source_id||item.release_id<=previous)return false;previous=item.release_id;}
    return declared===digest(fields)&&id==='obs_'+declared;
  }catch{return false;}
}
function compatible(before,after){return before&&before.namespace===after.namespace&&before.source_id===after.source_id&&before.scope===after.scope;}
function candidateId(fields){return 'candidate_'+digest(fields);}
function candidate(beforeItem,afterItem,kind,context){
  const fields={namespace:afterItem.namespace,source_id:afterItem.source_id,release_id:afterItem.release_id,kind,
    field:FINDING_FIELDS[kind],before_evidence_id:beforeItem?.id??null,after_evidence_id:afterItem.id,
    watchlist_version:context.watchlistVersion??'watchlist-v1'};
  return {id:candidateId(fields),...fields};
}
export function detect(before,after,context={}) {
  if(!observationValid(after))fail('invalid_after_observation');
  if(before&&!observationValid(before))fail('invalid_before_observation');
  if(before&&!compatible(before,after))return {outcome:'insufficient_evidence',candidates:[],reason:'scope_changed'};
  if(['unavailable','deferred'].includes(after.state))return {outcome:'source_unavailable',candidates:[],reason:after.state};
  if(after.state==='unstable')return {outcome:'unstable_observation',candidates:[],reason:'moving_identity'};
  if(!before)return {outcome:after.state==='captured'?'baseline_created':'partial_observation',candidates:[],reason:'no_comparison_head'};
  if(before.state!=='captured')return {outcome:'insufficient_evidence',candidates:[],reason:'inadmissible_comparison_head'};
  const older=new Map(before.items.map(item=>[item.release_id,item]));const candidates=[];
  for(const item of after.items){
    const old=older.get(item.release_id);
    if(!old){if(after.state==='captured')candidates.push(candidate(null,item,'newly_observed_release',context));continue;}
    if(old.tag_name!==item.tag_name)candidates.push(candidate(old,item,'tag_changed',context));
    if(old.prerelease!==item.prerelease)candidates.push(candidate(old,item,'prerelease_flag_changed',context));
    if(canonical(old.assets)!==canonical(item.assets))candidates.push(candidate(old,item,'asset_metadata_changed',context));
    if(old.notes_digest!==item.notes_digest)candidates.push(candidate(old,item,'notes_text_changed',context));
  }
  candidates.sort((a,b)=>a.id.localeCompare(b.id));
  return {outcome:after.state==='partial'?'partial_observation':candidates.length?'changed':'unchanged_in_observed_scope',
    candidates,reason:after.state==='partial'?'positive_only_partial':'declared_bounded_procedure'};
}
export function makeBundle(before,after,context={}) {
  const detection=detect(before,after,context);
  const evidence={};for(const item of [...(before?.items??[]),...after.items])evidence[item.id]=item;
  const fields={namespace:after.namespace,source_id:after.source_id,before,after,
    candidates:detection.candidates,evidence,watchlist_version:context.watchlistVersion??'watchlist-v1',
    outcome:detection.outcome,normalizer_version:NORMALIZER_VERSION,verifier_version:VERIFIER_VERSION};
  const d=digest(fields);return {...fields,id:'bundle_'+d,digest:d};
}
export function validateBundle(bundle){
  try{const{id,digest:declared,...fields}=bundle;return id==='bundle_'+declared&&declared===digest(fields)&&
    observationValid(bundle.after)&&(!bundle.before||observationValid(bundle.before))&&
    bundle.namespace===bundle.after.namespace&&bundle.source_id===bundle.after.source_id&&
    bundle.normalizer_version===NORMALIZER_VERSION&&bundle.verifier_version===VERIFIER_VERSION;}catch{return false;}
}
export function proposalFromCandidate(c,method='deterministic_baseline'){
  if(!METHODS.includes(method))fail('invalid_method');
  return {candidate_id:c.id,kind:c.kind,field:c.field,before_evidence_id:c.before_evidence_id,after_evidence_id:c.after_evidence_id,method};
}
export function baseline(bundle){
  if(!validateBundle(bundle))fail('invalid_bundle');
  return {method:'deterministic_baseline',outcome:bundle.outcome,proposals:bundle.candidates.map(c=>proposalFromCandidate(c))};
}
export function verify(proposal,bundle) {
  const reject=(reason,status='unsupported')=>({status,reason,method:proposal?.method??null,verifier_version:VERIFIER_VERSION,bundle_digest:bundle?.digest??null});
  if(!validateBundle(bundle))return reject('invalid_bundle','insufficient');
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))return reject('invalid_proposal');
  const allowed=['candidate_id','kind','field','before_evidence_id','after_evidence_id','method'];
  if(Object.keys(proposal).some(key=>!allowed.includes(key))||!METHODS.includes(proposal.method))return reject('invalid_proposal_schema');
  if(!Object.hasOwn(FINDING_FIELDS,proposal.kind)||FINDING_FIELDS[proposal.kind]!==proposal.field)return reject('invalid_predicate');
  if(typeof proposal.candidate_id!=='string'||typeof proposal.after_evidence_id!=='string')return reject('missing_evidence');
  const after=bundle.evidence[proposal.after_evidence_id], before=proposal.before_evidence_id===null?null:bundle.evidence[proposal.before_evidence_id];
  if(!after||!validateEvidence(after)||after.namespace!==bundle.namespace||after.source_id!==bundle.source_id)return reject('after_scope');
  if(!bundle.after.items.some(x=>x.id===after.id))return reject('wrong_after_revision');
  if(!['captured','partial'].includes(bundle.after.state))return reject('inadmissible_after','insufficient');
  if(!bundle.before||bundle.before.state!=='captured'||!compatible(bundle.before,bundle.after))return reject('missing_comparison_history','insufficient');
  if(before&&(!validateEvidence(before)||before.namespace!==after.namespace||before.source_id!==after.source_id||before.release_id!==after.release_id))return reject('before_identity');
  if(proposal.kind!=='newly_observed_release'&&(!before||!bundle.before.items.some(x=>x.id===before.id)))return reject('wrong_before_revision');
  if(proposal.kind==='newly_observed_release'&&(before||proposal.before_evidence_id!==null))return reject('unexpected_before_revision');
  const expectedId=candidateId({namespace:after.namespace,source_id:after.source_id,release_id:after.release_id,
    kind:proposal.kind,field:proposal.field,before_evidence_id:before?.id??null,after_evidence_id:after.id,watchlist_version:bundle.watchlist_version});
  if(proposal.candidate_id!==expectedId)return reject('candidate_identity');
  // Predicates use operands directly. They do not trust detector membership or call detect.
  let supported=false;
  switch(proposal.kind){
    case 'newly_observed_release':
      supported=bundle.after.state==='captured'&&!bundle.before.items.some(x=>x.release_id===after.release_id);break;
    case 'tag_changed':supported=before.tag_name!==after.tag_name;break;
    case 'prerelease_flag_changed':supported=before.prerelease!==after.prerelease;break;
    case 'asset_metadata_changed':
      supported=before.assets.length!==after.assets.length||before.assets.some((a,i)=>{
        const b=after.assets[i];return !b||a.id!==b.id||a.name!==b.name||a.size!==b.size||a.content_type!==b.content_type;
      });break;
    case 'notes_text_changed':supported=before.notes_digest!==after.notes_digest;break;
  }
  return {status:supported?'supported':'unsupported',reason:supported?'predicate_supported':'predicate_false',
    method:proposal.method,bundle_digest:bundle.digest,verifier_version:VERIFIER_VERSION,
    operands:{namespace:bundle.namespace,source_id:after.source_id,release_id:after.release_id,
      before_evidence_id:before?.id??null,after_evidence_id:after.id,kind:proposal.kind,field:proposal.field},
    execution_receipt:digest({proposal,bundle_digest:bundle.digest,verifier_version:VERIFIER_VERSION})};
}
export function renderFinding(proposal,bundle,decision=verify(proposal,bundle)){
  const checked=verify(proposal,bundle);
  if(checked.status!=='supported'||decision.status!=='supported'||decision.bundle_digest!==bundle.digest||decision.execution_receipt!==checked.execution_receipt)fail('unsupported_claim');
  const after=bundle.evidence[proposal.after_evidence_id],before=bundle.evidence[proposal.before_evidence_id];
  const prefix='Release '+after.release_id+' in source '+after.source_id+' ';
  const sentences={
    newly_observed_release:()=>prefix+'was newly observed in the declared scope.',
    tag_changed:()=>prefix+'has an observed exact tag change from '+before.tag_name+' to '+after.tag_name+'.',
    prerelease_flag_changed:()=>prefix+'has an observed prerelease flag change from '+before.prerelease+' to '+after.prerelease+'.',
    asset_metadata_changed:()=>prefix+'has changed captured asset metadata. Binary contents were not checked.',
    notes_text_changed:()=>prefix+'has a changed release-note text digest. The meaning of the text was not assessed.'
  };
  return {text:sentences[proposal.kind](),method:proposal.method,bundle_digest:bundle.digest,evidence_ids:[before?.id,after.id].filter(Boolean),
    coverage:bundle.after.coverage,scope:bundle.after.scope};
}

