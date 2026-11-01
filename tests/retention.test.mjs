import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {Store} from '../packages/workflow/store.mjs';
import {runCollection} from '../scripts/collect.mjs';
import {createSource} from '../packages/collector/index.mjs';
import {pruneCollectorHistory,planCollectorPrune,snapshotCollectorHistory} from '../packages/collector/retention.mjs';
import {normalizeRelease,makeObservation,makeBundle,baseline} from '../packages/domain/index.mjs';

const source=createSource('vercel/eve',1001);
const raw=tag=>({id:101,tag_name:tag,draft:false,prerelease:false,created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z',assets:[],body:'Authored fixture.'});
function fixture(t){
 const folder=mkdtempSync(join(tmpdir(),'watchtower-retention-')),path=join(folder,'state.sqlite'),opened=[];
 t.after(()=>{for(const s of opened)s.close();assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep)&&basename(folder).startsWith('watchtower-retention-'));rmSync(folder,{recursive:true,force:true});});
 return {open(){const s=new Store(path);opened.push(s);return s;}};
}
async function capture(store,namespace,index){
 return runCollection({store,namespace,sources:[source],runKey:'job-'+String(index).padStart(4,'0'),transport:async request=>({status:200,headers:{'content-type':'application/json'},body:request.url.includes('?')?[raw('v'+index)]:raw('v'+index)})});
}
function counts(store,ns){return Object.fromEntries(['collector_jobs','collector_runs','collector_attempts','collector_cache','observations','evidence','briefings','approvals','publications'].map(table=>[table,store.db.prepare('SELECT count(*) AS n FROM '+table+' WHERE namespace=?').get(ns).n]));}

test('collector retention clean: more than 100 jobs succeed, fresh connection preserves domain history and latest two revisions',async t=>{
 const temp=fixture(t),s=temp.open(),ns='test:retention';let clock=s.now();s.now=()=>++clock;
 for(let i=0;i<105;i++){const report=await capture(s,ns,i);assert.equal(report.state,'captured');}
 const other=temp.open(),actual=counts(other,ns);
 assert.equal(actual.collector_jobs,100);assert.equal(actual.collector_runs,100);assert.equal(actual.observations,105);assert.equal(actual.evidence,105);
 assert.equal(other.listSources(ns)[0].comparisonHead.runId,s.listSources(ns)[0].comparisonHead.runId);
 assert.ok(other.getRun(ns,'collect-'+(await import('../packages/domain/index.mjs')).digest({namespace:ns,runKey:'job-0000',sourceId:1001})));
 let calls=0;await assert.rejects(runCollection({store:s,namespace:ns,sources:[source],runKey:'job-0000',transport:async()=>{calls++;return {status:200,headers:{'content-type':'application/json'},body:[]};}}),/collection_run_key_already_exists/);assert.equal(calls,0);
 const result=pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1});
 assert.equal(result.retained.runs,2);assert.equal(result.retained.jobs,2);assert.equal(result.evidence_deleted,false);
 assert.equal(counts(other,ns).observations,105);assert.equal(counts(other,ns).evidence,105);
});

test('collector retention preserves old approved and published exact before/after manifests',async t=>{
 const temp=fixture(t),s=temp.open(),ns='test:pinned';let clock=s.now();s.now=()=>++clock;
 const a=await capture(s,ns,0),b=await capture(s,ns,1);
 const before=normalizeRelease(raw('v0'),{namespace:ns,sourceId:1001}),after=normalizeRelease(raw('v1'),{namespace:ns,sourceId:1001});
 const bundle=makeBundle(makeObservation({namespace:ns,sourceId:1001,items:[before],scope:'bounded-github-v1'}),makeObservation({namespace:ns,sourceId:1001,items:[after],scope:'bounded-github-v1'}));
 const briefing=s.prepareBriefing({namespace:ns,method:'deterministic_baseline',bundle,beforeRunId:a.outcomes[0].run_id,afterRunId:b.outcomes[0].run_id,findings:baseline(bundle).proposals,evidenceIds:[before.id,after.id],coverage:{complete:true}});
 const approval=s.approveBriefing(ns,briefing.digest,{reviewer:'synthetic',scope:ns});
 const receipt=s.publishBriefing(ns,briefing.digest,{operationKey:'pinned-publication',approvalId:approval.id});
 for(let i=2;i<8;i++)await capture(s,ns,i);
 const result=pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1});
 assert.equal(result.retained.jobs,4);assert.equal(result.deleted.jobs,4);
 const other=temp.open();
 for(const report of [a,b])assert.ok(other.db.prepare('SELECT 1 FROM collector_runs WHERE namespace=? AND run_id=?').get(ns,report.outcomes[0].run_id));
 assert.equal(counts(other,ns).approvals,1);assert.equal(counts(other,ns).publications,1);
 assert.equal(other.publishBriefing(ns,briefing.digest,{operationKey:'pinned-publication',approvalId:approval.id}).receiptId,receipt.receiptId);
 assert.ok(other.getEvidence(ns,before.id));assert.ok(other.getEvidence(ns,after.id));
});

test('collector retention violation: impossible budget and interrupted deletes roll back with no cross-namespace change',async t=>{
 const temp=fixture(t),s=temp.open(),ns='test:atomic';let clock=s.now();s.now=()=>++clock;
 for(let i=0;i<5;i++)await capture(s,ns,i);await capture(s,'test:foreign',0);
 const initial=counts(s,ns),foreign=counts(s,'test:foreign');
 assert.throws(()=>pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1,maxRows:1}),/collector_pinned_budget_requires_operator/);
 assert.deepEqual(counts(temp.open(),ns),initial);
 s.db.exec("CREATE TRIGGER interrupt_prune BEFORE DELETE ON collector_jobs BEGIN SELECT RAISE(ABORT,'interrupted_prune'); END");
 assert.throws(()=>pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1}),/interrupted_prune/);
 const other=temp.open();assert.deepEqual(counts(other,ns),initial);assert.deepEqual(counts(other,'test:foreign'),foreign);
});

test('collector retention removes only expired cache and respects an unfinished job with live lease',async t=>{
 const temp=fixture(t),s=temp.open(),ns='test:cache_retention';for(let i=0;i<4;i++)await capture(s,ns,i);
 s.db.prepare('INSERT INTO collector_jobs VALUES (?,?,?,?,?,?,?)').run(ns,'unfinished','a'.repeat(64),0,null,'collecting','{}');
 const lease=s.acquireLease(ns,1001,'active',120000);
 s.db.prepare("UPDATE collector_cache SET payload=json_set(payload,'$.expires_at','2000-01-01T00:00:00Z') WHERE namespace=?").run(ns);
 const result=pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1});
 assert.ok(result.deleted.cache>0);assert.ok(result.pinned_jobs.some(job=>job.id==='unfinished'&&job.reasons.includes('unfinished_job')));
 const other=temp.open();assert.equal(counts(other,ns).collector_cache,0);assert.equal(counts(other,ns).observations,4);
 s.releaseLease(lease);const final=pruneCollectorHistory(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1});assert.ok(final.delete_jobs.includes('unfinished'));
});

test('collector retention empty input and mixed scope refuse before writes',async t=>{
 assert.throws(()=>planCollectorPrune(),/invalid_retention_snapshot/);
 const temp=fixture(t),s=temp.open(),ns='test:invalid';await capture(s,ns,0);
 const snapshot=snapshotCollectorHistory(s,ns);
 assert.throws(()=>planCollectorPrune({...snapshot,jobs:[{...snapshot.jobs[0],namespace:'live'}]}),/retention_namespace_mismatch/);
 assert.throws(()=>pruneCollectorHistory(s,''),/invalid_collector_retention_scope/);
 assert.throws(()=>planCollectorPrune(snapshot,{keepLatestRevisions:0}),/invalid_collector_retention/);
 assert.throws(()=>planCollectorPrune(snapshot,{maxBytes:0}),/invalid_collector_retention/);
 assert.equal(counts(temp.open(),ns).collector_jobs,1);
});
