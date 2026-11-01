import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../packages/domain/index.mjs';
import {createSource,planSource,collectSource,nativeTransport} from '../packages/collector/index.mjs';
import {PersistentPostgresCache,persistCollectorArtifactsPostgres} from '../packages/collector/postgres-cache.mjs';
import {pruneCollectorHistoryPostgres} from '../packages/collector/retention-postgres.mjs';
import {collectionPreflight} from './collect.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const safeRunKey=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);

/** Administrator collector. HTTP occurs outside short fenced Postgres transactions. */
export async function runPostgresCollection({store,namespace,sources,runKey,transport=nativeTransport,now,watchlist,
 watchedIdsBySource={},limits={},signal}){
 if(!store||store.backend!=='postgres')fail('postgres_backend_required');
 if(!/^(live|synthetic|test:[A-Za-z0-9_-]+)$/.test(namespace??''))fail('invalid_collection_namespace');
 if(!Array.isArray(sources)||sources.length<1||sources.length>4||new Set(sources.map(s=>s.sourceId)).size!==sources.length||new Set(sources.map(s=>s.label)).size!==sources.length)fail('invalid_collection_sources');
 for(const source of sources)createSource(source.label,source.sourceId);
 if(!safeRunKey(runKey)||typeof transport!=='function')fail('invalid_collection_command');
 if(namespace==='live'){
  const preflight=collectionPreflight(watchlist,{backend:'postgres_verified'});
  if(!preflight.ready_for_live_collection||sources.length!==4||sources.some((source,i)=>source.label!==watchlist.sources[i].label||source.sourceId!==watchlist.sources[i].source_id))fail('live_collection_prerequisites_incomplete');
  if(transport!==nativeTransport)fail('live_collection_transport_refused');
 }
 await store.ready();
 for(const source of sources){
  const existing=(await store.db.query('SELECT repository_label FROM watchtower.sources WHERE namespace=$1 AND source_id=$2',[namespace,source.sourceId])).rows[0];
  if(existing&&existing.repository_label!==source.label)fail('source_identity_conflict');
  await store.registerSource(namespace,source.sourceId,source.label);
 }
 await pruneCollectorHistoryPostgres(store,namespace);
 const prepared=[];
 const states=await store.listSources(namespace);
 for(const source of sources){
  const sourceState=states.find(row=>row.sourceId===source.sourceId),previousItems=[];
  for(const id of sourceState?.comparisonHead?.evidenceIds??[]){const record=await store.getEvidence(namespace,id);if(record)previousItems.push({...record.data,observed_at:new Date(record.capturedAt).toISOString()});}
  const plan=planSource({source,namespace,now,watchedIds:watchedIdsBySource[source.sourceId]??[],previousItems});
  prepared.push({source,previousItems,plan,expectedHead:sourceState?.comparisonHead?.runId??null});
 }
 const jobPlan={namespace,runKey,watchlist_version:watchlist?.version??'watchlist-v1',plans:prepared.map(row=>row.plan),global_attempt_budget:24,backend:'postgres'};
 const planDigest=digest(jobPlan);
 await store.transaction(async db=>{
  await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR SHARE',[namespace]);
  if((await db.query('SELECT id FROM watchtower.collector_jobs WHERE namespace=$1 AND id=$2',[namespace,runKey])).rowCount)fail('collection_run_key_already_exists');
  for(const source of sources){const runId='collect-'+digest({namespace,runKey,sourceId:source.sourceId});if((await db.query('SELECT id FROM watchtower.observations WHERE namespace=$1 AND id=$2',[namespace,runId])).rowCount)fail('collection_run_key_already_exists');}
  await db.query('INSERT INTO watchtower.collector_jobs(namespace,id,plan_digest,started_at,finished_at,state,payload) VALUES($1,$2,$3,$4,NULL,$5,$6)',[namespace,runKey,planDigest,await store.now(db),'collecting',jobPlan]);
 });
 const budget={remaining:24},outcomes=[],runDeadline=AbortSignal.timeout(45000),runSignal=signal?AbortSignal.any([signal,runDeadline]):runDeadline;
 for(const {source,previousItems,expectedHead} of prepared){
  const runId='collect-'+digest({namespace,runKey,sourceId:source.sourceId});let lease;
  try{
   lease=await store.acquireLease(namespace,source.sourceId,'collector-'+randomUUID(),120000);
   if(lease.expectedHead!==expectedHead)fail('head_changed_before_collection');
   const cache=await PersistentPostgresCache.open(store,namespace,source.sourceId);
   const result=await collectSource({source,namespace,transport,cache,budget,now,watchedIds:watchedIdsBySource[source.sourceId]??[],previousItems,limits,signal:runSignal});
   const coverage={...result.coverage,complete:result.coverage.procedure_complete,next_eligible_at:result.next_eligible_at,
    warning:result.coverage.procedure_complete?'Bounded metadata procedure only. Complete release history is not established.':result.coverage.uncovered_scope};
   const persisted=await store.recordObservation({namespace,sourceId:source.sourceId,lease,expectedHead:lease.expectedHead,evidence:result.items,status:result.state,coverage,scope:result.plan.procedure_version,runId,
    onCommit:({db,namespace:commitNamespace,runId:commitRunId})=>persistCollectorArtifactsPostgres({db,namespace:commitNamespace,runId:commitRunId,jobId:runKey,result,cache,generation:lease.generation})});
   outcomes.push({source_id:source.sourceId,run_id:runId,state:result.state,attempted:result.attempts.length,comparison_head:persisted.comparisonHead,next_eligible_at:result.next_eligible_at,persistence:'committed_with_fence',mode:result.mode,backend:store.backend});
  }catch(error){
   if(lease)await store.releaseLease(lease);
   outcomes.push({source_id:source.sourceId,run_id:runId,state:'refused',error_code:error.code??'collection_command_failed',persistence:'not_committed',mode:namespace==='live'?'live_source':'synthetic',backend:store.backend});
  }
 }
 const state=outcomes.some(row=>row.persistence!=='committed_with_fence')?'failed':outcomes.every(row=>row.state==='captured')?'captured':'incomplete';
 const report={namespace,mode:namespace==='live'?'live_source':'synthetic',backend:store.backend,job_id:runKey,plan_digest:planDigest,state,attempt_budget:24,attempted:24-budget.remaining,budget_remaining:budget.remaining,
  live_collection_executed:namespace==='live',workflow_dispatch_succeeded:false,outcomes};
 await store.transaction(async db=>{
  await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR SHARE',[namespace]);
  await db.query('UPDATE watchtower.collector_jobs SET state=$1,finished_at=$2,payload=$3 WHERE namespace=$4 AND id=$5',[state,await store.now(db),{plan:jobPlan,result:report},namespace,runKey]);
 });
 report.retention=await pruneCollectorHistoryPostgres(store,namespace);
 return report;
}

export async function main(args=process.argv.slice(2)){
 if(args.length!==2||args[0]!=='--run-key'||!safeRunKey(args[1]))fail('usage_collect_postgres_run_key');
 const watchlist=JSON.parse(await readFile(join(root,'config/watchlist.json'),'utf8'));
 const preflight=collectionPreflight(watchlist,{backend:'postgres_verified'});
 if(!preflight.ready_for_live_collection)fail('live_collection_prerequisites_incomplete');
 const {PostgresStore}=await import('../packages/workflow/postgres.mjs');
 const store=await PostgresStore.create();
 try{
  const report=await runPostgresCollection({store,namespace:'live',sources:watchlist.sources.map(source=>createSource(source.label,source.source_id)),runKey:args[1],watchlist,watchedIdsBySource:Object.fromEntries(watchlist.sources.map(source=>[source.source_id,source.watched_ids??[]]))});
  await mkdir(join(root,'reports/collection'),{recursive:true});
  await writeFile(join(root,'reports/collection',args[1]+'.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));return report.state==='failed'?1:0;
 }finally{await store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.code??'collection_failed');process.exitCode=1;});
