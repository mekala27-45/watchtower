import { validateEvidence, digest } from '../domain/index.mjs';

const validNamespace = value => typeof value === 'string' && /^(live|synthetic|test:[A-Za-z0-9_-]+)$/.test(value);
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => JSON.stringify(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function installCollectorTables(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS collector_jobs(
      namespace TEXT NOT NULL, id TEXT NOT NULL, plan_digest TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, state TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(namespace,id)
    );
    CREATE TABLE IF NOT EXISTS collector_runs(
      namespace TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
      source_id INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace,run_id),
      FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id),
      FOREIGN KEY(namespace,job_id) REFERENCES collector_jobs(namespace,id)
    );
    CREATE TABLE IF NOT EXISTS collector_attempts(
      namespace TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(namespace,run_id,request_id),
      FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id)
    );
    CREATE TABLE IF NOT EXISTS collector_cache(
      namespace TEXT NOT NULL, source_id INTEGER NOT NULL, cache_key TEXT NOT NULL,
      run_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(namespace,source_id,cache_key),
      FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id),
      FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id)
    );
  `);
}

function validateEntry(entry, key, namespace, sourceId) {
  const evidenceKeys = new Set(['id','digest','namespace','source_id','release_id','tag_name','draft','prerelease','published_at','created_at','assets','notes_digest','notes_bytes','normalizer_version']);
  if (!entry || entry.key !== key || entry.validation_state !== 'valid' ||
      entry.source_policy_version !== 'source-policy-v1' ||
      !Array.isArray(entry.items) || entry.items.length > 20 ||
      !entry.items.every(item => validateEvidence(item) && item.namespace === namespace && item.source_id === sourceId && Object.keys(item).every(key => evidenceKeys.has(key))) ||
      entry.digest !== digest(entry.items) || typeof entry.has_next !== 'boolean' ||
      !['captured_at','checked_at','expires_at'].every(k => typeof entry[k] === 'string' && Number.isFinite(Date.parse(entry[k]))) ||
      (entry.etag !== null && (typeof entry.etag !== 'string' || entry.etag.length > 512 || /[\r\n\0]/.test(entry.etag)))) fail('invalid_cache_entry');
  const allowed = ['key','items','digest','etag','captured_at','checked_at','expires_at','source_policy_version','validation_state','has_next'];
  if (Object.keys(entry).some(k => !allowed.includes(k))) fail('unexpected_cache_field');
  if (Buffer.byteLength(canonical(entry)) > 1048576) fail('cache_entry_too_large');
}

export class PersistentCache {
  constructor(store, namespace, sourceId) {
    if (!validNamespace(namespace) || !Number.isSafeInteger(sourceId) || sourceId < 1) fail('invalid_cache_scope');
    this.store = store; this.namespace = namespace; this.sourceId = sourceId; this.staged = new Map();
  }
  get(key) {
    if (!validKey(key)) fail('invalid_cache_key');
    const staged = this.staged.get(key);
    if (staged) return structuredClone(staged);
    const row = this.store.db.prepare('SELECT payload FROM collector_cache WHERE namespace=? AND source_id=? AND cache_key=?').get(this.namespace,this.sourceId,key);
    if (!row) return undefined;
    const value = JSON.parse(row.payload);
    try { validateEntry(value,key,this.namespace,this.sourceId); }
    catch { return undefined; }
    return structuredClone(value);
  }
  set(key, entry) {
    if (!validKey(key)) fail('invalid_cache_key');
    validateEntry(entry,key,this.namespace,this.sourceId);
    this.staged.set(key,structuredClone(entry));
    return this;
  }
  commit({ db, namespace, runId, generation }) {
    if (namespace !== this.namespace || !Number.isSafeInteger(generation) || generation < 1) fail('cache_commit_scope');
    const statement = db.prepare(`INSERT INTO collector_cache VALUES (?,?,?,?,?,?)
      ON CONFLICT(namespace,source_id,cache_key) DO UPDATE SET
      run_id=excluded.run_id,generation=excluded.generation,payload=excluded.payload
      WHERE collector_cache.generation<=excluded.generation`);
    for (const [key,value] of this.staged) statement.run(namespace,this.sourceId,key,runId,generation,canonical(value));
  }
}

export function persistCollectorArtifacts({ db, namespace, runId, jobId, result, cache, generation }) {
  if (result.namespace !== namespace || cache.namespace !== namespace || result.source_id !== cache.sourceId) fail('collector_artifact_scope');
  const allowedAttempt = ['request_id','path','started_at','finished_at','status','error_code','consumed_budget','response_bytes','duration_ms','unconditional_recovery','cache_key','rate_limit','cache_outcome'];
  const statement = db.prepare('INSERT INTO collector_attempts VALUES (?,?,?,?)');
  for (const attempt of result.attempts) {
    if (Object.keys(attempt).some(key => !allowedAttempt.includes(key))) fail('unsafe_attempt_field');
    statement.run(namespace,runId,attempt.request_id,canonical(attempt));
  }
  const manifest = {
    namespace,mode:result.mode,backend:'sqlite_local_candidate',source_id:result.source_id,
    source_label:result.source_label,state:result.state,plan:result.plan,errors:result.errors,
    checked_at:result.checked_at,next_eligible_at:result.next_eligible_at,
    active_duration_ms:result.active_duration_ms,budget_remaining:result.budget_remaining,
    coverage:result.coverage,request_attempt_count:result.attempts.length,
  };
  db.prepare('INSERT INTO collector_runs VALUES (?,?,?,?,?)').run(namespace,runId,jobId,result.source_id,canonical(manifest));
  cache.commit({db,namespace,runId,generation});
  const totals = ['collector_jobs','collector_runs','collector_attempts','collector_cache'].map(table =>
    db.prepare('SELECT count(*) AS rows, coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM ' + table + ' WHERE namespace=?').get(namespace));
  if (totals.reduce((sum,row) => sum+row.rows,0) > 10000 || totals.reduce((sum,row) => sum+row.bytes,0) > 16777216) fail('collector_retention_budget_exhausted');
}

