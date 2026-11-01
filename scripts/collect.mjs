import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../packages/workflow/store.mjs';
import { digest } from '../packages/domain/index.mjs';
import { SOURCE_LABELS, API_VERSION, createSource, planSource, collectSource } from '../packages/collector/index.mjs';
import { PersistentCache, installCollectorTables, persistCollectorArtifacts } from '../packages/collector/persistent-cache.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fail(code) { throw Object.assign(new Error(code), { code }); }
const safeRunKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export function collectionPreflight(watchlist, { backend = 'sqlite_local_candidate' } = {}) {
  if (!watchlist || !Array.isArray(watchlist.sources) || watchlist.sources.length !== 4 ||
      JSON.stringify(watchlist.sources.map(s => s.label)) !== JSON.stringify(SOURCE_LABELS)) fail('invalid_fixed_watchlist');
  const sources = watchlist.sources.map(source => ({
    label: source.label, source_id: source.source_id,
    identity_verified: source.identity_verified === true && Number.isSafeInteger(source.source_id) && source.source_id > 0 &&
      typeof source.identity_evidence === 'string' && source.identity_evidence.length > 0,
  }));
  const blockers = [];
  if (sources.some(s => !s.identity_verified)) blockers.push('repository_numeric_identities_unresolved');
  if (watchlist.api_version !== API_VERSION || watchlist.api_version_verified !== true) blockers.push('rest_api_version_unverified');
  if (backend !== 'postgres_verified') blockers.push('direct_postgres_adapter_unavailable');
  return {
    schema_version: 'collection-preflight-v1', namespace: 'live', mode: 'operator_preflight',
    backend, watchlist_version: watchlist.version, sources, blockers,
    ready_for_live_collection: blockers.length === 0,
    requests_attempted: 0, live_collection_executed: false, workflow_dispatch_succeeded: false,
    planned_global_attempt_budget: 24, planned_source_deadline_ms: 45000, planned_lease_ms: 120000,
    next_action: 'Resolve fixed repository identities through the actual runner, verify the REST API version, and complete the direct Postgres adapter before live dispatch.',
  };
}

/**
 * Reversible local-candidate collection with an injected controlled transport.
 * Network work occurs outside transactions. The Store commit fence gates the
 * observation, attempts and staged cache together. No public route calls this.
 */
export async function runCollection({
  store, namespace, sources, runKey, transport, now,
  watchedIdsBySource = {}, limits = {}, signal,
}) {
  if (!store || store.backend !== 'sqlite_local_candidate') fail('unsupported_local_backend');
  if (!/^(synthetic|test:[A-Za-z0-9_-]+)$/.test(namespace ?? '')) fail('local_collection_namespace_refused');
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4 ||
      new Set(sources.map(s => s.sourceId)).size !== sources.length ||
      new Set(sources.map(s => s.label)).size !== sources.length) fail('invalid_collection_sources');
  for (const source of sources) createSource(source.label, source.sourceId);
  if (!safeRunKey(runKey) || typeof transport !== 'function') fail('invalid_collection_command');
  installCollectorTables(store);
  const prepared = sources.map(source => {
    const existing = store.db.prepare('SELECT label FROM sources WHERE namespace=? AND source_id=?').get(namespace,source.sourceId);
    if (existing && existing.label !== source.label) fail('source_identity_conflict');
    store.registerSource(namespace,source.sourceId,source.label);
    const sourceState = store.listSources(namespace).find(s => s.sourceId === source.sourceId);
    const previousItems = (sourceState?.comparisonHead?.evidenceIds ?? []).map(id => store.getEvidence(namespace,id)).filter(Boolean).map(record => ({...record.data,observed_at:new Date(record.capturedAt).toISOString()}));
    const plan = planSource({source,namespace,now,watchedIds:watchedIdsBySource[source.sourceId] ?? [],previousItems});
    return {source,previousItems,plan,expectedHead:sourceState?.comparisonHead?.runId ?? null};
  });
  const jobPlan = {namespace,runKey,watchlist_version:'watchlist-v1',plans:prepared.map(p => p.plan),global_attempt_budget:24,local_candidate:true};
  const planDigest = digest(jobPlan);
  if (store.db.prepare('SELECT id FROM collector_jobs WHERE namespace=? AND id=?').get(namespace,runKey)) fail('collection_run_key_already_exists');
  if (store.db.prepare('SELECT count(*) AS count FROM collector_jobs WHERE namespace=?').get(namespace).count >= 100) fail('collector_history_budget_exhausted');
  store.db.prepare('INSERT INTO collector_jobs VALUES (?,?,?,?,?,?,?)').run(namespace,runKey,planDigest,store.now(),null,'planned',JSON.stringify(jobPlan));
  const budget = {remaining:24}; const outcomes = [];
  const runDeadline = AbortSignal.timeout(45000);
  const runSignal = signal ? AbortSignal.any([signal,runDeadline]) : runDeadline;
  store.db.prepare('UPDATE collector_jobs SET state=? WHERE namespace=? AND id=?').run('collecting',namespace,runKey);
  for (const {source,previousItems,expectedHead} of prepared) {
    const runId = 'collect-' + digest({namespace,runKey,sourceId:source.sourceId});
    let lease;
    try {
      lease = store.acquireLease(namespace,source.sourceId,'collector-' + randomUUID(),120000);
      if (lease.expectedHead !== expectedHead) fail('head_changed_before_collection');
      const cache = new PersistentCache(store,namespace,source.sourceId);
      const result = await collectSource({source,namespace,transport,cache,budget,now,watchedIds:watchedIdsBySource[source.sourceId] ?? [],previousItems,limits,signal:runSignal});
      const coverage = { ...result.coverage, complete: result.coverage.procedure_complete, next_eligible_at:result.next_eligible_at,
        warning: result.coverage.procedure_complete ? 'Bounded metadata procedure only. Complete release history is not established.' : result.coverage.uncovered_scope };
      const persisted = store.recordObservation({
        namespace,sourceId:source.sourceId,lease,expectedHead:lease.expectedHead,evidence:result.items,
        status:result.state,coverage,scope:result.plan.procedure_version,runId,
        onCommit: ({db,namespace:commitNamespace,runId:commitRunId}) => persistCollectorArtifacts({
          db,namespace:commitNamespace,runId:commitRunId,jobId:runKey,result,cache,generation:lease.generation,
        }),
      });
      outcomes.push({source_id:source.sourceId,run_id:runId,state:result.state,attempted:result.attempts.length,
        comparison_head:persisted.comparisonHead,next_eligible_at:result.next_eligible_at,
        persistence:'committed_with_fence',mode:'synthetic',backend:store.backend});
    } catch (error) {
      if (lease) store.releaseLease(lease);
      outcomes.push({source_id:source.sourceId,run_id:runId,state:'refused',error_code:error.code ?? 'collection_command_failed',persistence:'not_committed',mode:'synthetic',backend:store.backend});
    }
  }
  const state = outcomes.some(row => row.persistence !== 'committed_with_fence') ? 'failed' :
    outcomes.every(row => row.state === 'captured') ? 'captured' : 'incomplete';
  const report = {namespace,mode:'synthetic',backend:store.backend,job_id:runKey,plan_digest:planDigest,
    state,attempt_budget:24,attempted:24-budget.remaining,budget_remaining:budget.remaining,
    live_collection_executed:false,workflow_dispatch_succeeded:false,outcomes};
  store.db.prepare('UPDATE collector_jobs SET state=?,finished_at=?,payload=? WHERE namespace=? AND id=?').run(state,store.now(),JSON.stringify({plan:jobPlan,result:report}),namespace,runKey);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--check')) fail('unsupported_collection_argument');
  const watchlist = JSON.parse(await readFile(join(root,'config/watchlist.json'),'utf8'));
  const report = collectionPreflight(watchlist);
  await mkdir(join(root,'reports/collection'),{recursive:true});
  await writeFile(join(root,'reports/collection/preflight.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if (!args.includes('--check')) fail('live_collection_prerequisites_incomplete');
  return report.ready_for_live_collection ? 0 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {process.exitCode=code;}).catch(error => {console.error(error.code ?? error.message);process.exitCode=1;});
}

