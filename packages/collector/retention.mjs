const fail = code => { throw Object.assign(new Error(code), { code }); };
const validNamespace = value => typeof value === 'string' && /^(live|synthetic|test:[A-Za-z0-9_-]+)$/.test(value);
const bytes = row => Buffer.byteLength(row.payload ?? '', 'utf8');
const orderedNewest = rows => [...rows].sort((a,b)=>(b.finished_at ?? b.captured_at ?? b.started_at ?? 0)-(a.finished_at ?? a.captured_at ?? a.started_at ?? 0)||String(b.id ?? b.run_id).localeCompare(String(a.id ?? a.run_id)));
const defaults = Object.freeze({keepRecentJobs:100,keepRecentRunsPerSource:100,keepLatestRevisions:2,maxRows:10000,maxBytes:16777216,unfinishedGraceMs:300000});
export const COLLECTOR_RETENTION_DEFAULTS = defaults;

/** Pure reference selection. It does not delete observations, evidence or receipts. */
export function planCollectorPrune(snapshot, options = {}) {
  const settings = {...defaults,...options};
  if (!snapshot || !validNamespace(snapshot.namespace) || !Number.isSafeInteger(snapshot.now) ||
      !['jobs','runs','attempts','cache','observations','evidence','memberships','heads','briefings','briefingEvidence','leases'].every(key=>Array.isArray(snapshot[key]))) fail('invalid_retention_snapshot');
  if (!Number.isInteger(settings.keepRecentJobs)||settings.keepRecentJobs<1||settings.keepRecentJobs>1000 ||
      !Number.isInteger(settings.keepRecentRunsPerSource)||settings.keepRecentRunsPerSource<1||settings.keepRecentRunsPerSource>1000 ||
      !Number.isInteger(settings.keepLatestRevisions)||settings.keepLatestRevisions<2||settings.keepLatestRevisions>100 ||
      !Number.isInteger(settings.maxRows)||settings.maxRows<1||settings.maxRows>10000 ||
      !Number.isInteger(settings.maxBytes)||settings.maxBytes<1||settings.maxBytes>16777216 ||
      !Number.isInteger(settings.unfinishedGraceMs)||settings.unfinishedGraceMs<120000||settings.unfinishedGraceMs>3600000) fail('invalid_collector_retention');
  const allRows=['jobs','runs','attempts','cache','observations','evidence','memberships','heads','briefings','briefingEvidence','leases'].flatMap(key=>snapshot[key]);
  if(allRows.some(row=>row.namespace!==snapshot.namespace))fail('retention_namespace_mismatch');
  const runById=new Map(snapshot.runs.map(row=>[row.run_id,row]));
  const observations=new Map(snapshot.observations.map(row=>[row.id,row]));
  const jobs=new Map(snapshot.jobs.map(row=>[row.id,row]));
  const pinnedRuns=new Map(),pinnedJobs=new Map(),pinnedEvidence=new Set();
  const pinRun=(id,reason)=>{if(id&&runById.has(id)){if(!pinnedRuns.has(id))pinnedRuns.set(id,new Set());pinnedRuns.get(id).add(reason);}};
  const pinJob=(id,reason)=>{if(id&&jobs.has(id)){if(!pinnedJobs.has(id))pinnedJobs.set(id,new Set());pinnedJobs.get(id).add(reason);}};
  for(const row of orderedNewest(snapshot.jobs).slice(0,settings.keepRecentJobs))pinJob(row.id,'recent_job');
  const sources=new Set(snapshot.runs.map(row=>row.source_id));
  for(const sourceId of sources){
    const rows=snapshot.runs.filter(row=>row.source_id===sourceId).map(row=>({...row,captured_at:observations.get(row.run_id)?.captured_at??0}));
    for(const row of orderedNewest(rows).slice(0,settings.keepRecentRunsPerSource))pinRun(row.run_id,'recent_source_attempt');
  }
  for(const head of snapshot.heads){pinRun(head.latest_attempt,'latest_attempt');pinRun(head.comparison_head,'comparison_head');}
  for(const row of snapshot.briefingEvidence)pinnedEvidence.add(row.evidence_id);
  for(const row of snapshot.briefings){
    let briefing;try{briefing=JSON.parse(row.payload);}catch{fail('invalid_retained_briefing');}
    if(!briefing||briefing.namespace!==snapshot.namespace)fail('invalid_retained_briefing');
    pinRun(briefing.beforeRunId,'briefing_before');pinRun(briefing.afterRunId,'briefing_after');
    for(const dependency of briefing.sourceHeads??[])pinRun(dependency.comparison_head,'briefing_dependency');
  }
  const usableIds=new Set(snapshot.memberships.filter(row=>observations.get(row.observation_id)?.status==='captured').map(row=>row.evidence_id));
  const counts=new Map();
  for(const row of orderedNewest(snapshot.evidence).filter(row=>usableIds.has(row.id))){
    const key=row.source_id+':'+row.item_id;const count=(counts.get(key)??0)+1;counts.set(key,count);
    if(count<=settings.keepLatestRevisions)pinnedEvidence.add(row.id);
  }
  // Keep the latest usable observation that demonstrates each retained revision.
  // Exact before/after observation dependencies are pinned separately above.
  for(const evidenceId of pinnedEvidence){
    const candidates=snapshot.memberships.filter(row=>row.evidence_id===evidenceId)
      .map(row=>observations.get(row.observation_id)).filter(row=>row?.status==='captured');
    const latest=orderedNewest(candidates)[0];if(latest)pinRun(latest.id,'retained_evidence');
  }
  const liveLease=snapshot.leases.some(row=>row.expires_at>snapshot.now);
  for(const job of snapshot.jobs){
    if(job.finished_at===null&&(snapshot.now-job.started_at<settings.unfinishedGraceMs||liveLease))pinJob(job.id,'unfinished_job');
  }
  const deleteCache=[];
  for(const row of snapshot.cache){
    let cache;try{cache=JSON.parse(row.payload);}catch{}
    const usable=cache?.validation_state==='valid'&&Number.isFinite(Date.parse(cache?.expires_at))&&Date.parse(cache.expires_at)>snapshot.now;
    if(usable)pinRun(row.run_id,'usable_cache');
    else deleteCache.push({source_id:row.source_id,cache_key:row.cache_key});
  }
  // A job is the atomic watchlist manifest. Keep all of its source runs together.
  for(const id of pinnedRuns.keys())pinJob(runById.get(id).job_id,'pinned_run');
  for(const run of snapshot.runs)if(pinnedJobs.has(run.job_id))pinRun(run.run_id,'retained_job');
  const deletedRuns=snapshot.runs.filter(row=>!pinnedRuns.has(row.run_id)).map(row=>row.run_id).sort();
  const deletedRunSet=new Set(deletedRuns);
  const deletedJobs=snapshot.jobs.filter(row=>!pinnedJobs.has(row.id)).map(row=>row.id).sort();
  const deletedJobSet=new Set(deletedJobs);
  const deletedCacheKeys=new Set(deleteCache.map(row=>row.source_id+':'+row.cache_key));
  const retained={
    jobs:snapshot.jobs.filter(row=>!deletedJobSet.has(row.id)),
    runs:snapshot.runs.filter(row=>!deletedRunSet.has(row.run_id)),
    attempts:snapshot.attempts.filter(row=>!deletedRunSet.has(row.run_id)),
    cache:snapshot.cache.filter(row=>!deletedCacheKeys.has(row.source_id+':'+row.cache_key)),
  };
  const retainedRows=Object.values(retained).flat();
  const retainedBytes=retainedRows.reduce((sum,row)=>sum+bytes(row),0);
  if(retainedRows.length>settings.maxRows||retainedBytes>settings.maxBytes)fail('collector_pinned_budget_requires_operator');
  return {
    namespace:snapshot.namespace,settings,
    delete_runs:deletedRuns,delete_jobs:deletedJobs,delete_cache:deleteCache,
    deleted:{jobs:deletedJobs.length,runs:deletedRuns.length,attempts:snapshot.attempts.filter(row=>deletedRunSet.has(row.run_id)).length,cache:deleteCache.length},
    retained:{jobs:retained.jobs.length,runs:retained.runs.length,attempts:retained.attempts.length,cache:retained.cache.length,rows:retainedRows.length,bytes:retainedBytes},
    pinned_runs:[...pinnedRuns].sort(([a],[b])=>a.localeCompare(b)).map(([id,reasons])=>({id,reasons:[...reasons].sort()})),
    pinned_jobs:[...pinnedJobs].sort(([a],[b])=>a.localeCompare(b)).map(([id,reasons])=>({id,reasons:[...reasons].sort()})),
    evidence_deleted:false,observations_deleted:false,receipts_deleted:false,
  };
}

export function snapshotCollectorHistory(store,namespace) {
  if(!store?.db||!validNamespace(namespace))fail('invalid_collector_retention_scope');
  const read=table=>store.db.prepare('SELECT * FROM '+table+' WHERE namespace=?').all(namespace);
  return {namespace,now:store.now(),jobs:read('collector_jobs'),runs:read('collector_runs'),attempts:read('collector_attempts'),cache:read('collector_cache'),
    observations:read('observations'),evidence:read('evidence'),memberships:read('observation_evidence'),heads:read('heads'),
    briefings:read('briefings'),briefingEvidence:read('briefing_evidence'),leases:read('leases')};
}

/** Run under a short writer transaction so pins cannot change during pruning. */
export function pruneCollectorHistory(store,namespace,options={}) {
  if(!store?.db||typeof store.transaction!=='function'||!validNamespace(namespace))fail('invalid_collector_retention_scope');
  return store.transaction(()=>{
    const plan=planCollectorPrune(snapshotCollectorHistory(store,namespace),options);
    for(const row of plan.delete_cache)store.db.prepare('DELETE FROM collector_cache WHERE namespace=? AND source_id=? AND cache_key=?').run(namespace,row.source_id,row.cache_key);
    for(const id of plan.delete_runs){
      store.db.prepare('DELETE FROM collector_attempts WHERE namespace=? AND run_id=?').run(namespace,id);
      store.db.prepare('DELETE FROM collector_runs WHERE namespace=? AND run_id=?').run(namespace,id);
    }
    for(const id of plan.delete_jobs)store.db.prepare('DELETE FROM collector_jobs WHERE namespace=? AND id=?').run(namespace,id);
    return {...plan,backend:store.backend};
  });
}
