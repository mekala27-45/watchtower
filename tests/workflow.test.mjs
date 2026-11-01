import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../packages/workflow/store.mjs';
import {normalizeRelease,makeObservation,makeBundle,baseline} from '../packages/domain/index.mjs';

function withStore(fn){const root=mkdtempSync(join(tmpdir(),'watchtower-store-'));const path=join(root,'state.sqlite');const store=new Store(path);try{return fn(store,path);}finally{store.close();rmSync(root,{recursive:true,force:true});}}
function codes(code){return e=>e.code===code;}
function seed(s,ns='test:source'){s.registerSource(ns,23,'authored/test');const lease=s.acquireLease(ns,23,'worker');return s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true,scope:'synthetic fixture'},evidence:[{itemId:1,tag:'v1',assets:[],notesDigest:digest('authored')}],runId:'initial'});}
function demo(s){const session=s.createDemoSession();const briefing=s.prepareDemo(session.id,session.capability);const approval=s.approveDemo(session.id,session.capability,{briefingDigest:briefing.digest});return {session,briefing,approval};}
test('workflow gate clean: second connection sees the source head and immutable evidence',()=>withStore((s,path)=>{
 const r=seed(s), other=new Store(path);
 try{assert.equal(other.listSources('test:source')[0].comparisonHead.runId,r.runId);assert.equal(other.getEvidence('test:source',r.evidenceIds[0]).data.tag,'v1');assert.equal(other.db.prepare('SELECT count(*) AS n FROM events WHERE namespace=?').get('test:source').n,1);}finally{other.close();}
 assert.throws(()=>s.db.prepare('UPDATE evidence SET payload=? WHERE namespace=?').run('{}','test:source'),/immutable_evidence/);
}));
test('workflow gate violation: stale returning worker cannot commit after a replacement',()=>withStore(s=>{
 seed(s);let old=s.acquireLease('test:source',23,'old');s.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=?').run('test:source');
 const replacement=s.acquireLease('test:source',23,'replacement');
 s.recordObservation({namespace:'test:source',sourceId:23,lease:replacement,expectedHead:replacement.expectedHead,status:'captured',coverage:{complete:true},evidence:[],runId:'replacement'});
 assert.throws(()=>s.recordObservation({namespace:'test:source',sourceId:23,lease:old,expectedHead:old.expectedHead,status:'captured',coverage:{complete:true},evidence:[],runId:'old'}),codes('stale_lease'));
 assert.equal(s.listSources('test:source')[0].comparisonHead.runId,'replacement');
}));
test('workflow gate empty input refuses',()=>withStore(s=>{
 assert.throws(()=>s.acquireLease('',23,'worker'),codes('invalid_namespace'));
 assert.throws(()=>s.recordObservation({}),codes('invalid_namespace'));
 assert.throws(()=>s.prepareBriefing({namespace:'test:source',findings:[],evidenceIds:[],method:'deterministic_baseline',coverage:{complete:true}}),codes('invalid_briefing'));
}));
test('matching lease generation is insufficient after database clock expiry',()=>withStore(s=>{
 seed(s);const lease=s.acquireLease('test:source',23,'expired');s.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=?').run('test:source');
 assert.throws(()=>s.renewLease(lease),codes('stale_lease'));
 assert.throws(()=>s.recordObservation({namespace:'test:source',sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[]}),codes('stale_lease'));
}));
test('expected head conflict rejects a matching live lease',()=>withStore(s=>{
 seed(s);const lease=s.acquireLease('test:source',23,'worker');
 assert.throws(()=>s.recordObservation({namespace:'test:source',sourceId:23,lease,expectedHead:null,status:'captured',coverage:{complete:true},evidence:[]}),codes('head_conflict'));
}));
test('failed attempt advances latest attempt without erasing comparison baseline',()=>withStore(s=>{
 seed(s);const lease=s.acquireLease('test:source',23,'failed');
 s.recordObservation({namespace:'test:source',sourceId:23,lease,expectedHead:lease.expectedHead,status:'unavailable',coverage:{complete:false,reason:'timeout'},runId:'timeout'});
 const source=s.listSources('test:source')[0];assert.equal(source.latestAttempt.status,'unavailable');assert.equal(source.comparisonHead.runId,'initial');
}));
test('partial positive evidence is retained without a complete negative claim',()=>withStore(s=>{
 seed(s);const lease=s.acquireLease('test:source',23,'partial');
 const r=s.recordObservation({namespace:'test:source',sourceId:23,lease,expectedHead:lease.expectedHead,status:'partial',coverage:{complete:false,reason:'page_two_failed'},evidence:[{itemId:1,tag:'v2'}],runId:'partial'});
 assert.ok(s.getEvidence('test:source',r.evidenceIds[0]));assert.equal(s.listSources('test:source')[0].comparisonHead.runId,'initial');
}));
test('an exception inside collection rolls evidence, head and event back together',()=>withStore((s,path)=>{
 seed(s);const lease=s.acquireLease('test:source',23,'rollback');
 s.testHooks.afterEvidence=()=>{throw new Error('interrupted');};
 assert.throws(()=>s.recordObservation({namespace:'test:source',sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[{itemId:2,tag:'never committed'}],runId:'rollback'}),/interrupted/);
 const other=new Store(path);try{assert.equal(other.db.prepare('SELECT count(*) AS n FROM evidence WHERE namespace=?').get('test:source').n,1);assert.equal(other.getRun('test:source','rollback'),null);}finally{other.close();}
}));
test('publication clean: identical retry recovers one immutable receipt from another connection',()=>withStore((s,path)=>{
 const {session,briefing}=demo(s),args={briefingDigest:briefing.digest,operationKey:'publish-1'};
 const first=s.publishDemo(session.id,session.capability,args);const other=new Store(path);
 try{const retry=other.publishDemo(session.id,session.capability,args);assert.equal(retry.receiptId,first.receiptId);assert.equal(retry.recovered,true);assert.equal(other.db.prepare('SELECT count(*) AS n FROM publications WHERE namespace=?').get(session.namespace).n,1);}finally{other.close();}
 assert.throws(()=>s.db.prepare('DELETE FROM publications WHERE namespace=?').run(session.namespace),/immutable_publication/);
}));
test('publication violation: a changed payload under the same operation key conflicts',()=>withStore(s=>{
 const {session,briefing}=demo(s);s.publishDemo(session.id,session.capability,{briefingDigest:briefing.digest,operationKey:'key'});
 assert.throws(()=>s.publishBriefing(session.namespace,briefing.digest,{operationKey:'key',payloadDigest:digest('different')}),codes('operation_conflict'));
}));
test('publication empty input refuses',()=>withStore(s=>{
 assert.throws(()=>s.publishBriefing('test:source','',{operationKey:''}),codes('invalid_operation'));
}));
test('approval is required and namespace scoped',()=>withStore(s=>{
 const session=s.createDemoSession(),b=s.prepareDemo(session.id,session.capability);
 assert.throws(()=>s.publishDemo(session.id,session.capability,{briefingDigest:b.digest,operationKey:'no-approval'}),codes('approval_required'));
 assert.throws(()=>s.approveBriefing(session.namespace,b.digest,{reviewer:'synthetic',scope:'live'}),codes('reviewer_scope'));
}));
test('source version change makes approval stale without rewriting history',()=>withStore(s=>{
 const {session,briefing}=demo(s);const lease=s.acquireLease(session.namespace,23,'new-observation');
 s.recordObservation({namespace:session.namespace,sourceId:23,lease,expectedHead:lease.expectedHead,status:'unavailable',coverage:{complete:false,reason:'timeout'},runId:'newer-attempt'});
 assert.equal(s.getBriefing(session.namespace,briefing.digest).state,'review_required');
 assert.throws(()=>s.publishDemo(session.id,session.capability,{briefingDigest:briefing.digest,operationKey:'stale'}),codes('review_required'));
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM approvals WHERE namespace=?').get(session.namespace).n,1);
}));
test('committed retry precedes approval expiry while a new effect requires unexpired approval',()=>withStore(s=>{
 const session=s.createDemoSession(),b=s.prepareDemo(session.id,session.capability);
 const approval=s.approveBriefing(session.namespace,b.digest,{reviewer:'synthetic',scope:session.namespace,ttlMs:20});
 const first=s.publishBriefing(session.namespace,b.digest,{operationKey:'committed',approvalId:approval.id});
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
 assert.equal(s.publishBriefing(session.namespace,b.digest,{operationKey:'committed',approvalId:approval.id}).receiptId,first.receiptId);
 assert.throws(()=>s.publishBriefing(session.namespace,b.digest,{operationKey:'new-operation',approvalId:approval.id}),codes('approval_expired'));
}));
test('demo capability hash, expiry, quota and cross-namespace isolation are durable',()=>withStore((s,path)=>{
 const a=s.createDemoSession(),b=s.createDemoSession();const briefing=s.prepareDemo(a.id,a.capability);
 assert.equal(s.db.prepare('SELECT capability_hash FROM sessions WHERE id=?').get(a.id).capability_hash,digest(a.capability));
 assert.throws(()=>s.getDemoSession(a.id,b.capability),codes('session_not_found'));assert.equal(s.getBriefing(b.namespace,briefing.digest),null);
 assert.throws(()=>s.approveDemo(b.id,b.capability,{briefingDigest:briefing.digest}),codes('not_found'));
 s.db.prepare('UPDATE sessions SET remaining=0 WHERE id=?').run(a.id);const other=new Store(path);
 try{assert.throws(()=>other.prepareDemo(a.id,a.capability),codes('quota_exhausted'));}finally{other.close();}
 s.db.prepare('UPDATE sessions SET expires_at=0 WHERE id=?').run(b.id);assert.throws(()=>s.getDemoSession(b.id,b.capability),codes('session_expired'));
}));
test('global session creation quota is shared across connections',()=>withStore((s,path)=>{
 for(let i=0;i<5;i++)s.createDemoSession({clientKey:digest('client')});
 const other=new Store(path);try{assert.throws(()=>other.createDemoSession({clientKey:digest('client')}),codes('session_creation_quota'));assert.ok(other.createDemoSession({clientKey:digest('different-client')}));}finally{other.close();}
}));
test('retention retains pinned briefing evidence and latest two revisions, second connection verifies',()=>withStore((s,path)=>{
 const {session,briefing}=demo(s);
 for(let i=0;i<4;i++){const lease=s.acquireLease(session.namespace,23,'revision-'+i);const item=normalizeRelease({id:2301,tag_name:'authored-'+i,draft:false,prerelease:false,assets:[],body:'Authored.',created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z'},{namespace:session.namespace,sourceId:23});s.recordObservation({namespace:session.namespace,sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[item],runId:'revision-'+i});}
 const result=s.pruneEvidence(session.namespace);assert.equal(result.deleted,2);
 const other=new Store(path);try{for(const ref of briefing.evidence)assert.ok(other.getEvidence(session.namespace,ref.id));assert.equal(other.db.prepare('SELECT count(*) AS n FROM evidence WHERE namespace=?').get(session.namespace).n,4);}finally{other.close();}
 assert.throws(()=>s.pruneEvidence(session.namespace,{maxRows:1}),codes('retention_budget_requires_operator'));
}));
test('retention rejects invalid empty limits and cannot delete pinned evidence through FK',()=>withStore(s=>{
 const {session,briefing}=demo(s);
 assert.throws(()=>s.pruneEvidence('',{}),codes('invalid_namespace'));
 assert.throws(()=>s.pruneEvidence(session.namespace,{keepLatest:0}),codes('invalid_retention'));
 assert.throws(()=>s.db.prepare('DELETE FROM evidence WHERE namespace=? AND id=?').run(session.namespace,briefing.evidence[0].id),/FOREIGN KEY/);
}));
test('briefing gate rejects forged supported flags and false predicates',()=>withStore(s=>{
 const ns='test:verification';
 const raw={id:101,tag_name:'v1',draft:false,prerelease:false,assets:[],body:'Authored.',created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z'};
 const before=normalizeRelease(raw,{namespace:ns,sourceId:23}),after=normalizeRelease({...raw,tag_name:'v2'},{namespace:ns,sourceId:23});
 s.registerSource(ns,23,'authored/verification');
 for(const [i,item] of [before,after].entries()){const lease=s.acquireLease(ns,23,'capture');s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,evidence:[item],status:'captured',coverage:{complete:true},runId:'observation-'+i});}
 const bundle=makeBundle(makeObservation({namespace:ns,sourceId:23,items:[before]}),makeObservation({namespace:ns,sourceId:23,items:[after]}));
 const proposal=baseline(bundle).proposals[0];
 const input={namespace:ns,method:'deterministic_baseline',bundle,beforeRunId:'observation-0',afterRunId:'observation-1',evidenceIds:[before.id,after.id],coverage:{complete:true}};
 assert.throws(()=>s.prepareBriefing({...input,findings:[{...proposal,supported:true}]}),codes('unsupported_finding'));
 assert.throws(()=>s.prepareBriefing({...input,findings:[{...proposal,before_evidence_id:after.id}]}),codes('unsupported_finding'));
 assert.throws(()=>s.prepareBriefing({...input,findings:[proposal],evidenceIds:[after.id]}),codes('verification_evidence_mismatch'));
 assert.throws(()=>s.prepareBriefing({...input,findings:[proposal],coverage:{complete:false}}),codes('coverage_mismatch'));
 const result=s.prepareBriefing({...input,findings:[proposal]});
 assert.ok(result.findings[0].verificationReceipt);
 assert.equal(result.findings[0].before,'v1');
 assert.equal(result.findings[0].after,'v2');
 assert.throws(()=>s.prepareBriefing({...input,method:'local_agent',findings:[{...proposal,method:'local_agent'}]}),codes('inference_receipt_required'));
 assert.throws(()=>s.prepareBriefing({...input,method:'recorded_local_agent',findings:[{...proposal,method:'recorded_local_agent'}]}),codes('inference_receipt_required'));
 const forged=makeBundle(makeObservation({namespace:ns,sourceId:23,items:[]}),makeObservation({namespace:ns,sourceId:23,items:[after]}));
 assert.throws(()=>s.prepareBriefing({...input,bundle:forged,findings:baseline(forged).proposals}),codes('observation_lineage_mismatch'));
 assert.throws(()=>s.prepareBriefing({...input,findings:[proposal],beforeRunId:'missing'}),codes('observation_lineage_mismatch'));
}));

