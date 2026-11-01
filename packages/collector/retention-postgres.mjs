import {planCollectorPrune} from './retention.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const validNamespace=value=>typeof value==='string'&&/^(live|synthetic|test:[A-Za-z0-9_-]+)$/.test(value);
const rows=async(db,sql,namespace)=>(await db.query(sql,[namespace])).rows;
const integerColumns=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,['source_id','item_id','started_at','finished_at','captured_at','expires_at','generation'].includes(key)&&value!==null?Number(value):value]));

export async function snapshotCollectorHistoryPostgres(db,namespace){
 if(!db?.query||!validNamespace(namespace))fail('invalid_collector_retention_scope');
 const queries={
  jobs:'SELECT namespace,id,plan_digest,started_at,finished_at,state,payload::text AS payload FROM watchtower.collector_jobs WHERE namespace=$1',
  runs:'SELECT namespace,run_id,job_id,source_id,payload::text AS payload FROM watchtower.collector_runs WHERE namespace=$1',
  attempts:'SELECT namespace,run_id,request_id,payload::text AS payload FROM watchtower.collector_attempts WHERE namespace=$1',
  cache:'SELECT namespace,source_id,cache_key,run_id,generation,payload::text AS payload FROM watchtower.collector_cache WHERE namespace=$1',
  observations:'SELECT namespace,id,source_id,state AS status,floor(extract(epoch FROM checked_at)*1000)::bigint AS captured_at FROM watchtower.observations WHERE namespace=$1',
  evidence:'SELECT namespace,id,source_id,release_id AS item_id,floor(extract(epoch FROM captured_at)*1000)::bigint AS captured_at FROM watchtower.evidence_revisions WHERE namespace=$1',
  memberships:'SELECT * FROM watchtower.observation_evidence WHERE namespace=$1',
  heads:'SELECT namespace,source_id,latest_attempt_id AS latest_attempt,comparison_head_id AS comparison_head FROM watchtower.source_heads WHERE namespace=$1',
  briefings:'SELECT namespace,digest,payload::text AS payload FROM watchtower.briefing_revisions WHERE namespace=$1',
  briefingEvidence:'SELECT * FROM watchtower.briefing_evidence WHERE namespace=$1',
  leases:'SELECT namespace,source_id,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at FROM watchtower.source_leases WHERE namespace=$1',
 };
 const snapshot={namespace,now:Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now)};
 for(const [key,sql] of Object.entries(queries))snapshot[key]=(await rows(db,sql,namespace)).map(integerColumns);
 return snapshot;
}

/** Namespace and head locks match registration, briefing and collection lock order. */
export async function pruneCollectorHistoryPostgres(store,namespace,options={}){
 if(!store?.db?.query||typeof store.transaction!=='function'||!validNamespace(namespace))fail('invalid_collector_retention_scope');
 return store.transaction(async db=>{
  await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR UPDATE',[namespace]);
  await db.query('SELECT source_id FROM watchtower.source_heads WHERE namespace=$1 ORDER BY source_id FOR UPDATE',[namespace]);
  await db.query('SELECT source_id FROM watchtower.source_leases WHERE namespace=$1 ORDER BY source_id FOR UPDATE',[namespace]);
  const plan=planCollectorPrune(await snapshotCollectorHistoryPostgres(db,namespace),options);
  for(const row of plan.delete_cache)await db.query('DELETE FROM watchtower.collector_cache WHERE namespace=$1 AND source_id=$2 AND cache_key=$3',[namespace,row.source_id,row.cache_key]);
  if(plan.delete_runs.length){
   await db.query('DELETE FROM watchtower.collector_attempts WHERE namespace=$1 AND run_id=ANY($2::text[])',[namespace,plan.delete_runs]);
   await db.query('DELETE FROM watchtower.collector_runs WHERE namespace=$1 AND run_id=ANY($2::text[])',[namespace,plan.delete_runs]);
  }
  if(plan.delete_jobs.length)await db.query('DELETE FROM watchtower.collector_jobs WHERE namespace=$1 AND id=ANY($2::text[])',[namespace,plan.delete_jobs]);
  return {...plan,backend:store.backend};
 });
}
