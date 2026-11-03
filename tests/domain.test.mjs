import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical,digest,normalizeRelease,validateEvidence,makeObservation,detect,makeBundle,baseline,verify,renderFinding} from '../packages/domain/index.mjs';
import {gradeFacts,expectedFacts,summarizeRows} from '../packages/domain/grader.mjs';
const scope={namespace:'synthetic:test',sourceId:1001};
const raw=(id=101,tag='v1')=>({id,tag_name:tag,draft:false,prerelease:false,published_at:'2026-10-01T12:00:00Z',
  created_at:'2026-09-30T12:00:00Z',body:'Authored',assets:[{id:10*id,name:'artifact',size:100,content_type:'application/octet-stream'}]});
const obs=(items,state='captured',extra={})=>makeObservation({...scope,items:items.map(r=>normalizeRelease(r,scope)),state,...extra});
const change=()=>makeBundle(obs([raw()]),obs([raw(101,'v2')]));
test('canonical digest is stable across object key order and refuses absent values',()=>{
  assert.equal(canonical({b:2,a:[1,true,null]}),canonical({a:[1,true,null],b:2}));
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
  assert.throws(()=>canonical(undefined));assert.throws(()=>canonical({value:NaN}));
});
test('normalizer clean gate keeps only factual fields and discards note prose',()=>{
  const r=raw();r.author={login:'fictional'};r.html_url='https://evil.invalid/';r.assets[0].download_count=8;
  const n=normalizeRelease(r,scope);assert.equal(n.release_id,101);assert.equal(n.notes_bytes,8);
  assert.equal(n.body,undefined);assert.equal(n.author,undefined);assert.equal(n.html_url,undefined);
  assert.deepEqual(Object.keys(n.assets[0]).sort(),['content_type','id','name','size']);assert.ok(validateEvidence(n));
});
test('normalizer violation gate refuses malformed, oversized and control data',()=>{
  assert.throws(()=>normalizeRelease({...raw(),id:0},scope),/invalid_release_id/);
  assert.throws(()=>normalizeRelease({...raw(),prerelease:'false'},scope),/invalid_prerelease/);
  assert.throws(()=>normalizeRelease({...raw(),tag_name:'a'.repeat(513)},scope),/invalid_tag_name/);
  assert.throws(()=>normalizeRelease({...raw(),body:'x'.repeat(262145)},scope),/invalid_body/);
  const bad=raw();bad.assets[0].size=-1;assert.throws(()=>normalizeRelease(bad,scope),/invalid_asset_size/);
  const duplicate=raw();duplicate.assets.push(structuredClone(duplicate.assets[0]));assert.throws(()=>normalizeRelease(duplicate,scope),/duplicate_asset_id/);
});
test('normalizer empty gate refuses missing release and namespace',()=>{
  assert.throws(()=>normalizeRelease(null,scope));assert.throws(()=>normalizeRelease({},scope));
  assert.throws(()=>normalizeRelease(raw(),{}));
});
test('normalized schema cannot be forged merely by recomputing its digest',()=>{
  const good=normalizeRelease(raw(),scope);const{id,digest:_,...fields}=good;fields.tag_name=123;
  const d=digest(fields);assert.equal(validateEvidence({...fields,id:'ev_'+d,digest:d}),false);
});
test('baseline creation avoids historical alert flood and scope changes refuse comparison',()=>{
  const after=obs([raw(),raw(102)]);assert.equal(detect(null,after).outcome,'baseline_created');
  assert.equal(detect(null,after).candidates.length,0);
  assert.equal(detect(after,obs([raw()], 'captured',{scope:'bounded-v2'})).outcome,'insufficient_evidence');
});
test('missing IDs and empty listings do not become deletion findings',()=>{
  const before=obs([raw(),raw(102)]);
  assert.deepEqual(detect(before,obs([raw()])).candidates,[]);
  assert.deepEqual(detect(before,obs([])).candidates,[]);
  const newIdentity=detect(before,obs([raw(),raw(102),raw(103)]));assert.equal(newIdentity.candidates.length,1);
  assert.equal(newIdentity.candidates[0].kind,'newly_observed_release');
});
test('partial retains supported positive facts but unknown never becomes no-op',()=>{
  const before=obs([raw()]);
  assert.equal(detect(before,obs([],'partial')).outcome,'partial_observation');
  assert.equal(detect(before,obs([],'unavailable')).outcome,'source_unavailable');
  assert.equal(detect(before,obs([],'deferred')).outcome,'source_unavailable');
  assert.equal(detect(before,obs([raw(101,'v2')],'unstable')).candidates.length,0);
  const partial=makeBundle(before,obs([raw(101,'v2')],'partial'));assert.equal(partial.outcome,'partial_observation');
  assert.equal(verify(baseline(partial).proposals[0],partial).status,'supported');
  assert.equal(detect(before,obs([raw(),raw(102)],'partial')).candidates.length,0);
  const misleading=obs([raw(101,'v2')],'partial',{coverage:{procedure_complete:true,uncovered_scope:[]}});
  assert.equal(misleading.coverage.procedure_complete,false);assert.ok(misleading.coverage.uncovered_scope.length);
});
test('each exact predicate verifies separately and rendering does not imply semantics',()=>{
  const before=raw(),after=raw(101,'v2');after.prerelease=true;after.body='Security';after.assets[0].size=200;
  const bundle=makeBundle(obs([before]),obs([after]));const result=baseline(bundle);
  assert.deepEqual(result.proposals.map(p=>p.kind).sort(),['asset_metadata_changed','notes_text_changed','prerelease_flag_changed','tag_changed']);
  for(const p of result.proposals)assert.equal(verify(p,bundle).status,'supported');
  const note=result.proposals.find(p=>p.kind==='notes_text_changed');assert.match(renderFinding(note,bundle).text,/meaning of the text was not assessed/);
});
test('tag revert has distinct transition key and duplicate evidence does not multiply facts',()=>{
  const a=obs([raw()]),b=obs([raw(101,'v2'),raw(101,'v2')]);
  const forward=detect(a,b),revert=detect(b,a);assert.equal(forward.candidates.length,1);
  assert.notEqual(forward.candidates[0].id,revert.candidates[0].id);
});
test('conflicting duplicate identity marks unstable without unsupported candidates',()=>{
  const inconsistent=obs([raw(),raw(101,'v2')]);assert.equal(inconsistent.state,'unstable');
  assert.equal(detect(obs([raw()]),inconsistent).outcome,'unstable_observation');
});
test('verifier clean gate checks supported operands',()=>{
  const bundle=change(),p=baseline(bundle).proposals[0],v=verify(p,bundle);
  assert.equal(v.status,'supported');assert.equal(v.operands.release_id,101);assert.ok(v.execution_receipt);
});
test('verifier violation gate rejects wrong identity, predicate, revision and digest',()=>{
  const bundle=change(),p=baseline(bundle).proposals[0];
  for(const forged of [{...p,candidate_id:'wrong'},{...p,field:'security'},
    {...p,after_evidence_id:p.before_evidence_id},{...p,approved:true},{...p,method:'combined_agent'}])
    assert.notEqual(verify(forged,bundle).status,'supported');
  const changed=structuredClone(bundle);changed.evidence[p.after_evidence_id].tag_name='forged';
  assert.notEqual(verify(p,changed).status,'supported');
  const cross=structuredClone(bundle);cross.namespace='synthetic:other';assert.notEqual(verify(p,cross).status,'supported');
});
test('verifier empty gate and claim rendering refuse absence or fabricated decision',()=>{
  const bundle=change(),p=baseline(bundle).proposals[0];assert.notEqual(verify(null,bundle).status,'supported');
  assert.notEqual(verify({},null).status,'supported');
  assert.throws(()=>renderFinding(null,bundle),/unsupported_claim/);
  assert.throws(()=>renderFinding(p,null),/unsupported_claim/);
  assert.throws(()=>renderFinding(p,bundle,{status:'supported',bundle_digest:bundle.digest}),/unsupported_claim/);
});
test('verifier independently rejects a false predicate with structurally valid identities',()=>{
  const bundle=makeBundle(obs([raw()]),obs([raw()])),item=bundle.after.items[0];
  const fields={namespace:scope.namespace,source_id:scope.sourceId,release_id:item.release_id,kind:'tag_changed',field:'tag_name',
    before_evidence_id:item.id,after_evidence_id:item.id,watchlist_version:'watchlist-v1'};
  const proposal={candidate_id:'candidate_'+digest(fields),kind:fields.kind,field:fields.field,
    before_evidence_id:item.id,after_evidence_id:item.id,method:'deterministic_baseline'};
  const decision=verify(proposal,bundle);assert.equal(decision.status,'unsupported');assert.equal(decision.reason,'predicate_false');
  const falseAcceptedFact={namespace:scope.namespace,source_id:scope.sourceId,release_id:item.release_id,
    before_evidence_id:item.id,after_evidence_id:item.id,kind:'tag_changed',field:'tag_name'};
  assert.equal(gradeFacts([],[falseAcceptedFact]).unsupported,1);
});
test('independent grader catches missing, extra, duplicate, wrong identity and predicate mutations',()=>{
  const fact={namespace:'synthetic:test',source_id:1,release_id:2,before_evidence_id:'a',after_evidence_id:'b',kind:'tag_changed',field:'tag_name'};
  assert.equal(gradeFacts([fact],[fact]).pass,true);
  assert.equal(gradeFacts([fact],[]).pass,false);
  assert.equal(gradeFacts([fact],[fact,{...fact,release_id:3}]).pass,false);
  assert.equal(gradeFacts([fact],[fact,fact]).pass,false);
  assert.equal(gradeFacts([fact],[{...fact,kind:'notes_text_changed',field:'notes_digest'}]).pass,false);
  assert.equal(gradeFacts([fact],[{...fact,after_evidence_id:'wrong'}]).pass,false);
  assert.equal(gradeFacts([],[]).precision.value,null);
  assert.throws(()=>summarizeRows([]),/empty_results/);
});
test('fixture plan covers twelve disjoint lineages per family and a balanced frozen model subset',()=>{
  const manifest=JSON.parse(readFileSync('fixtures/manifest.json','utf8'));
  const plan=JSON.parse(readFileSync('docs/evaluation-plan.json','utf8'));
  const{plan_digest,...payload}=plan;assert.equal(digest(payload),plan_digest);
  assert.equal(manifest.developmentIds.length,72);assert.equal(manifest.heldoutIds.length,72);assert.equal(manifest.modelSubsetIds.length,24);
  const lineages=new Set();
  for(const split of ['development','heldout'])for(const id of manifest[split==='heldout'?'heldoutIds':'developmentIds']){
    const f=JSON.parse(readFileSync('fixtures/'+split+'/'+id+'.json','utf8'));
    assert.equal(lineages.has(f.lineage),false);lineages.add(f.lineage);
    assert.ok(f.description&&f.truth.every(t=>t.reason));
  }
  for(const family of manifest.families)assert.equal(manifest.modelSubsetIds.filter(id=>id.startsWith(family+'-')).length,2);
});
test('fixture generation is deterministic in two fresh processes',()=>{
  const before=canonical(JSON.parse(readFileSync('fixtures/manifest.json','utf8')));
  const directory=mkdtempSync(join(tmpdir(),'watchtower-fixture-generation-'));
  try{
    const results=['first','second'].map(name=>{
      const root=join(directory,name);mkdirSync(join(root,'scripts'),{recursive:true});
      copyFileSync('scripts/generate-fixtures.mjs',join(root,'scripts/generate-fixtures.mjs'));
      const output=execFileSync(process.execPath,[join(root,'scripts/generate-fixtures.mjs')],{cwd:root,encoding:'utf8'});
      return {output,manifest:canonical(JSON.parse(readFileSync(join(root,'fixtures/manifest.json'),'utf8')))};
    });
    assert.deepEqual(results[0],results[1]);assert.equal(results[0].manifest,before);
    assert.equal(canonical(JSON.parse(readFileSync('fixtures/manifest.json','utf8'))),before);
  }finally{
    const within=relative(tmpdir(),directory);assert.ok(within&&!within.startsWith('..')&&!isAbsolute(within));
    rmSync(directory,{recursive:true,force:true});
  }
});
test('every development fixture is independently normalized and fact-graded',()=>{
  const manifest=JSON.parse(readFileSync('fixtures/manifest.json','utf8'));
  for(const id of manifest.developmentIds){
    const f=JSON.parse(readFileSync('fixtures/development/'+id+'.json','utf8'));
    const convert=o=>makeObservation({namespace:f.namespace,sourceId:f.source_id,state:o.state,scope:o.scope,
      items:o.raw_items.map(r=>normalizeRelease(r,{namespace:f.namespace,sourceId:f.source_id}))});
    let prior=f.observations[0]?convert(f.observations[0]):null;
    for(let i=1;i<f.observations.length;i++){
      const rawObservation=f.observations[i],truth=f.truth[i-1];
      if(rawObservation.expected_rejection){assert.throws(()=>convert(rawObservation),new RegExp(rawObservation.expected_rejection));continue;}
      const after=convert(rawObservation);assert.deepEqual(after.items,truth.expected_normalized,id);
      const bundle=makeBundle(prior,after),result=baseline(bundle);
      const emitted=result.proposals.map(p=>({namespace:f.namespace,source_id:f.source_id,release_id:bundle.evidence[p.after_evidence_id].release_id,
        before_evidence_id:p.before_evidence_id,after_evidence_id:p.after_evidence_id,kind:p.kind,field:p.field}));
      assert.equal(gradeFacts(expectedFacts(f,i),emitted).pass,true,id);
      assert.equal(result.outcome,truth.outcome,id);if(after.state==='captured')prior=after;
    }
  }
});

