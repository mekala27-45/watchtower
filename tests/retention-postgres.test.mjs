import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresStore} from '../packages/workflow/postgres.mjs';
import {runPostgresCollection} from '../scripts/collect-postgres.mjs';
import {createSource,cacheKey,endpoint} from '../packages/collector/index.mjs';
import {PersistentPostgresCache} from '../packages/collector/postgres-cache.mjs';
import {pruneCollectorHistoryPostgres} from '../packages/collector/retention-postgres.mjs';
import {normalizeRelease,makeObservation,makeBundle,baseline} from '../packages/domain/index.mjs';

const connectionString=process.env.WATCHTOWER_TEST_DATABASE_URL;
const source=createSource('vercel/eve',1001),scope=()=> 'test:collectorpg_'+randomUUID().replaceAll('-','');
const raw=tag=>({id:101,tag_name:tag,draft:false,prerelease:false,created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z',assets:[],body:'Authored fixture, never persisted.'});
const response=(body,status=200,extra={})=>({status,headers:{'content-type':'application/json',...extra},body});
const args=(store,namespace,index)=>({store,namespace,sources:[source],runKey:'job-'+index,transport:async request=>response(request.url.includes('?')?[raw('v'+index)]:raw('v'+index),200,{etag:'fixture-'+index})});
async function counts(store,ns){const result={};for(const table of ['collector_jobs','collector_runs','collector_attempts','collector_cache','observations','evidence_revisions','approvals','publications'])result[table]=Number((await store.db.query('SELECT count(*) AS n FROM watchtower.'+table+' WHERE namespace=$1',[ns])).rows[0].n);return result;}

test('Postgres collector empty scope and unverified live configuration refuse before network',async()=>{
 let calls=0;const transport=async()=>{calls++;return response([]);};
 await assert.rejects(runPostgresCollection({store:{backend:'postgres'},namespace:'',sources:[source],runKey:'empty',transport}),/invalid_collection_namespace/);
 await assert.rejects(runPostgresCollection({store:{backend:'postgres'},namespace:'test:empty',sources:[],runKey:'empty',transport}),/invalid_collection_sources/);
 await assert.rejects(runPostgresCollection({store:{backend:'postgres'},namespace:'live',sources:[source],runKey:'unverified',transport,watchlist:{}}),/invalid_fixed_watchlist/);
 assert.equal(calls,0);
});

test('actual PostgreSQL collector and reference retention contracts',{skip:!connectionString?'WATCHTOWER_TEST_DATABASE_URL absent; no PostgreSQL execution claimed':false,timeout:240000},async t=>{
 const s=await PostgresStore.create({connectionString}),other=await PostgresStore.create({connectionString});
 t.after(async()=>{await s.close();await other.close();});
 await t.test('fenced captures, cached 304 and exact published dependencies survive history pruning',async()=>{
  const ns=scope(),first=await runPostgresCollection(args(s,ns,0));assert.equal(first.state,'captured');
  const key=cacheKey({source,path:endpoint(source,{page:1}),namespace:ns}),cached=(await PersistentPostgresCache.open(other,ns,1001)).get(key);
  assert.equal(cached.etag,'fixture-0');let conditional=false;
  const revalidation=await runPostgresCollection({...args(other,ns,'revalidation'),transport:async request=>{
   if(request.url.includes('?')){conditional=request.headers['If-None-Match']==='fixture-0';return response('',304);}return response(raw('v0'));
  }});
  assert.equal(revalidation.state,'captured');assert.equal(conditional,true);
  assert.equal((await PersistentPostgresCache.open(s,ns,1001)).get(key).captured_at,cached.captured_at);
  const second=await runPostgresCollection(args(s,ns,1));assert.equal(second.state,'captured');
  const before=normalizeRelease(raw('v0'),{namespace:ns,sourceId:1001}),after=normalizeRelease(raw('v1'),{namespace:ns,sourceId:1001});
  const bundle=makeBundle(makeObservation({namespace:ns,sourceId:1001,items:[before],scope:'bounded-github-v1'}),makeObservation({namespace:ns,sourceId:1001,items:[after],scope:'bounded-github-v1'}));
  const briefing=await s.prepareBriefing({namespace:ns,method:'deterministic_baseline',bundle,beforeRunId:revalidation.outcomes[0].run_id,afterRunId:second.outcomes[0].run_id,findings:baseline(bundle).proposals,evidenceIds:[before.id,after.id],coverage:{complete:true}});
  const approval=await s.approveBriefing(ns,briefing.digest,{reviewer:'synthetic',scope:ns});
  const receipt=await s.publishBriefing(ns,briefing.digest,{operationKey:'pinned-publication',approvalId:approval.id});
  for(let i=2;i<5;i++)assert.equal((await runPostgresCollection(args(s,ns,i))).state,'captured');
  const result=await pruneCollectorHistoryPostgres(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1});
  assert.equal(result.retained.jobs,4);assert.equal(result.deleted.jobs,2);assert.equal(result.evidence_deleted,false);
  const saved=await counts(other,ns);assert.equal(saved.collector_runs,4);assert.equal(saved.observations,6);assert.equal(saved.evidence_revisions,5);assert.equal(saved.approvals,1);assert.equal(saved.publications,1);
  for(const report of [revalidation,second])assert.equal((await other.db.query('SELECT run_id FROM watchtower.collector_runs WHERE namespace=$1 AND run_id=$2',[ns,report.outcomes[0].run_id])).rowCount,1);
  assert.equal((await other.publishBriefing(ns,briefing.digest,{operationKey:'pinned-publication',approvalId:approval.id})).receiptId,receipt.receiptId);
  assert.ok(await other.getEvidence(ns,before.id));assert.ok(await other.getEvidence(ns,after.id));
  assert.equal((await other.listSources(ns))[0].comparisonHead.runId,(await s.listSources(ns))[0].comparisonHead.runId);
  assert.equal((await other.db.query("SELECT count(*) AS n FROM watchtower.collector_cache WHERE namespace=$1 AND payload::text LIKE '%never persisted%'",[ns])).rows[0].n,'0');
  let calls=0;await assert.rejects(runPostgresCollection({...args(s,ns,0),transport:async()=>{calls++;return response([]);}}),/collection_run_key_already_exists/);assert.equal(calls,0);
  const initial=await counts(other,ns);await assert.rejects(pruneCollectorHistoryPostgres(s,ns,{keepRecentJobs:1,keepRecentRunsPerSource:1,maxRows:1}),/collector_pinned_budget_requires_operator/);assert.deepEqual(await counts(other,ns),initial);
  await assert.rejects(pruneCollectorHistoryPostgres(s,''),/invalid_collector_retention_scope/);
 });
 await t.test('error after cache and attempts staging rolls all fenced state back',async()=>{
  const ns=scope(),original=s.recordObservation;
  s.recordObservation=async function(input){const onCommit=input.onCommit;return original.call(this,{...input,onCommit:async context=>{await onCommit(context);throw Object.assign(new Error('injected_artifact_fault'),{code:'injected_artifact_fault'});}});};
  let result;try{result=await runPostgresCollection(args(s,ns,0));}finally{s.recordObservation=original;}
  assert.equal(result.state,'failed');assert.equal(result.outcomes[0].error_code,'injected_artifact_fault');
  const saved=await counts(other,ns);for(const table of ['collector_runs','collector_attempts','collector_cache','observations','evidence_revisions'])assert.equal(saved[table],0);
  assert.equal((await other.listSources(ns))[0].comparisonHead,null);
 });
 await t.test('returning worker cannot commit cache or attempts after replacement advances head',async()=>{
  const ns=scope();let replaced=false;
  const result=await runPostgresCollection({...args(s,ns,0),transport:async()=>{
   if(!replaced){replaced=true;await other.db.query("UPDATE watchtower.source_leases SET expires_at=to_timestamp(0) WHERE namespace=$1 AND source_id=1001",[ns]);
    const lease=await other.acquireLease(ns,1001,'replacement',120000);
    await other.recordObservation({namespace:ns,sourceId:1001,lease,expectedHead:lease.expectedHead,evidence:[normalizeRelease(raw('replacement'),{namespace:ns,sourceId:1001})],status:'captured',coverage:{complete:true},runId:'replacement'});
   }return response([raw('v0')]);
  }});
  assert.equal(result.state,'failed');assert.equal(result.outcomes[0].error_code,'stale_lease');
  assert.equal((await s.listSources(ns))[0].comparisonHead.runId,'replacement');
  const saved=await counts(other,ns);assert.equal(saved.collector_attempts,0);assert.equal(saved.collector_cache,0);assert.equal(saved.observations,1);
 });
});
