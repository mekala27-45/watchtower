import {validateEntry} from './persistent-cache.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const validKey=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validNamespace=value=>typeof value==='string'&&/^(live|synthetic|test:[A-Za-z0-9_-]+)$/.test(value);

/** Load before HTTP; reads and writes during collection remain in memory until fenced commit. */
export class PersistentPostgresCache {
 constructor(namespace,sourceId){
  if(!validNamespace(namespace)||!Number.isSafeInteger(sourceId)||sourceId<1)fail('invalid_cache_scope');
  this.namespace=namespace;this.sourceId=sourceId;this.entries=new Map();this.staged=new Map();
 }
 static async open(store,namespace,sourceId){
  const cache=new PersistentPostgresCache(namespace,sourceId);
  const rows=(await store.db.query('SELECT cache_key,payload FROM watchtower.collector_cache WHERE namespace=$1 AND source_id=$2 LIMIT 101',[namespace,sourceId])).rows;
  if(rows.length>100)fail('cache_history_budget_exhausted');
  for(const row of rows){let value=row.payload;try{if(typeof value==='string')value=JSON.parse(value);validateEntry(value,row.cache_key,namespace,sourceId);cache.entries.set(row.cache_key,structuredClone(value));}catch{}}
  return cache;
 }
 get(key){if(!validKey(key))fail('invalid_cache_key');const value=this.staged.get(key)??this.entries.get(key);return value?structuredClone(value):undefined;}
 set(key,value){if(!validKey(key))fail('invalid_cache_key');validateEntry(value,key,this.namespace,this.sourceId);this.staged.set(key,structuredClone(value));return this;}
 async commit({db,namespace,runId,generation}){
  if(namespace!==this.namespace||!Number.isSafeInteger(generation)||generation<1)fail('cache_commit_scope');
  for(const [key,value] of this.staged)await db.query(`INSERT INTO watchtower.collector_cache(namespace,source_id,cache_key,run_id,generation,payload) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(namespace,source_id,cache_key) DO UPDATE SET run_id=EXCLUDED.run_id,generation=EXCLUDED.generation,payload=EXCLUDED.payload
   WHERE watchtower.collector_cache.generation<=EXCLUDED.generation`,[namespace,this.sourceId,key,runId,generation,value]);
 }
}

export async function persistCollectorArtifactsPostgres({db,namespace,runId,jobId,result,cache,generation}){
 if(result.namespace!==namespace||cache.namespace!==namespace||result.source_id!==cache.sourceId)fail('collector_artifact_scope');
 const allowedAttempt=['request_id','path','started_at','finished_at','status','error_code','consumed_budget','response_bytes','duration_ms','unconditional_recovery','cache_key','rate_limit','cache_outcome'];
 for(const attempt of result.attempts){
  if(Object.keys(attempt).some(key=>!allowedAttempt.includes(key)))fail('unsafe_attempt_field');
  await db.query('INSERT INTO watchtower.collector_attempts(namespace,run_id,request_id,payload) VALUES($1,$2,$3,$4)',[namespace,runId,attempt.request_id,attempt]);
 }
 const manifest={namespace,mode:result.mode,backend:'postgres',source_id:result.source_id,source_label:result.source_label,state:result.state,plan:result.plan,errors:result.errors,
  checked_at:result.checked_at,next_eligible_at:result.next_eligible_at,active_duration_ms:result.active_duration_ms,budget_remaining:result.budget_remaining,
  coverage:result.coverage,request_attempt_count:result.attempts.length};
 await db.query('INSERT INTO watchtower.collector_runs(namespace,run_id,job_id,source_id,payload) VALUES($1,$2,$3,$4,$5)',[namespace,runId,jobId,result.source_id,manifest]);
 await cache.commit({db,namespace,runId,generation});
 const totals=[];
 for(const table of ['collector_jobs','collector_runs','collector_attempts','collector_cache'])totals.push((await db.query('SELECT count(*)::bigint AS rows,coalesce(sum(octet_length(payload::text)),0)::bigint AS bytes FROM watchtower.'+table+' WHERE namespace=$1',[namespace])).rows[0]);
 if(totals.reduce((sum,row)=>sum+Number(row.rows),0)>10000||totals.reduce((sum,row)=>sum+Number(row.bytes),0)>16777216)fail('collector_retention_budget_exhausted');
}
