import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NORMALIZER_VERSION, VERIFIER_VERSION, normalizeRelease, validateEvidence, makeObservation, makeBundle, validateBundle, baseline, verify, renderFinding } from '../domain/index.mjs';

export const BACKEND = 'sqlite_local_candidate';
export const METHODS = ['deterministic_baseline', 'local_agent', 'recorded_local_agent'];
export const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
};
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function fail(code, status = 400) { const e = new Error(code); e.code = code; e.status = status; throw e; }
function required(value, label) { if (typeof value !== 'string' || !value.length || value.length > 300) fail('invalid_' + label); return value; }
function namespace(value) { required(value, 'namespace'); if (!/^(live|synthetic|demo:[a-f0-9-]{36}|test:[a-zA-Z0-9_-]+)$/.test(value)) fail('invalid_namespace'); return value; }
function sameHash(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function json(row, key = 'payload') { return row ? JSON.parse(row[key]) : null; }
const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(
 id TEXT PRIMARY KEY, namespace TEXT NOT NULL UNIQUE, capability_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, remaining INTEGER NOT NULL CHECK(remaining>=0)
);
CREATE TABLE IF NOT EXISTS session_limits(
 client_key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>=0),
 PRIMARY KEY(client_key,window_start)
);
CREATE TABLE IF NOT EXISTS sources(
 namespace TEXT NOT NULL, source_id INTEGER NOT NULL CHECK(source_id>0), label TEXT NOT NULL,
 PRIMARY KEY(namespace,source_id)
);
CREATE TABLE IF NOT EXISTS leases(
 namespace TEXT NOT NULL, source_id INTEGER NOT NULL, owner TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), expires_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,source_id), FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id)
);
CREATE TABLE IF NOT EXISTS observations(
 namespace TEXT NOT NULL, id TEXT NOT NULL, source_id INTEGER NOT NULL, digest TEXT NOT NULL,
 status TEXT NOT NULL, coverage TEXT NOT NULL, captured_at INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(namespace,id), UNIQUE(namespace,source_id,digest),
 FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id)
);
CREATE TABLE IF NOT EXISTS evidence(
 namespace TEXT NOT NULL, id TEXT NOT NULL, source_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
 digest TEXT NOT NULL, captured_at INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(namespace,id), UNIQUE(namespace,source_id,item_id,digest),
 FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id)
);
CREATE TABLE IF NOT EXISTS observation_evidence(
 namespace TEXT NOT NULL, observation_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
 PRIMARY KEY(namespace,observation_id,evidence_id),
 FOREIGN KEY(namespace,observation_id) REFERENCES observations(namespace,id),
 FOREIGN KEY(namespace,evidence_id) REFERENCES evidence(namespace,id)
);
CREATE TABLE IF NOT EXISTS heads(
 namespace TEXT NOT NULL, source_id INTEGER NOT NULL, latest_attempt TEXT, comparison_head TEXT,
 version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(namespace,source_id), FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id),
 FOREIGN KEY(namespace,latest_attempt) REFERENCES observations(namespace,id),
 FOREIGN KEY(namespace,comparison_head) REFERENCES observations(namespace,id)
);
CREATE TABLE IF NOT EXISTS briefings(
 namespace TEXT NOT NULL, digest TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('deterministic_baseline','local_agent','recorded_local_agent')),
 payload TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,digest)
);
CREATE TABLE IF NOT EXISTS briefing_evidence(
 namespace TEXT NOT NULL, briefing_digest TEXT NOT NULL, evidence_id TEXT NOT NULL,
 PRIMARY KEY(namespace,briefing_digest,evidence_id),
 FOREIGN KEY(namespace,briefing_digest) REFERENCES briefings(namespace,digest),
 FOREIGN KEY(namespace,evidence_id) REFERENCES evidence(namespace,id)
);
CREATE TABLE IF NOT EXISTS approvals(
 namespace TEXT NOT NULL, id TEXT NOT NULL, briefing_digest TEXT NOT NULL,
 reviewer TEXT NOT NULL, scope TEXT NOT NULL, approved_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,id), FOREIGN KEY(namespace,briefing_digest) REFERENCES briefings(namespace,digest)
);
CREATE TABLE IF NOT EXISTS publications(
 namespace TEXT NOT NULL, publication_key TEXT NOT NULL, briefing_digest TEXT NOT NULL,
 payload_digest TEXT NOT NULL, approval_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,publication_key), UNIQUE(namespace,briefing_digest,payload_digest),
 FOREIGN KEY(namespace,briefing_digest) REFERENCES briefings(namespace,digest),
 FOREIGN KEY(namespace,approval_id) REFERENCES approvals(namespace,id)
);
CREATE TABLE IF NOT EXISTS receipts(
 namespace TEXT NOT NULL, operation_key TEXT NOT NULL, payload_digest TEXT NOT NULL, publication_key TEXT NOT NULL,
 receipt_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(namespace,operation_key),
 FOREIGN KEY(namespace,publication_key) REFERENCES publications(namespace,publication_key)
);
CREATE TABLE IF NOT EXISTS events(
 namespace TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
 created_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace,id)
);
CREATE TRIGGER IF NOT EXISTS evidence_immutable BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'immutable_evidence'); END;
CREATE TRIGGER IF NOT EXISTS observation_immutable BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'immutable_observation'); END;
CREATE TRIGGER IF NOT EXISTS briefing_immutable BEFORE UPDATE ON briefings BEGIN SELECT RAISE(ABORT,'immutable_briefing'); END;
CREATE TRIGGER IF NOT EXISTS approval_immutable BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT,'immutable_approval'); END;
CREATE TRIGGER IF NOT EXISTS publication_immutable BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT,'immutable_publication'); END;
CREATE TRIGGER IF NOT EXISTS publication_no_delete BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT,'immutable_publication'); END;
CREATE TRIGGER IF NOT EXISTS receipt_immutable BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
CREATE TRIGGER IF NOT EXISTS receipt_no_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
CREATE TRIGGER IF NOT EXISTS event_immutable BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
`;

export class Store {
  constructor(path = ':memory:', { testHooks = {} } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.backend = BACKEND;
    this.testHooks = testHooks;
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec(schema);
  }
  close() { this.db.close(); }
  now() { return this.db.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now").get().now; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch(e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  event(ns, kind, subject, payload) {
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(ns, randomUUID(), kind, subject, this.now(), canonical(payload));
  }
  ready() { return this.db.prepare('SELECT 1 AS ready').get().ready === 1; }
  registerSource(ns, sourceId, label) {
    namespace(ns); if (!Number.isSafeInteger(sourceId) || sourceId <= 0) fail('invalid_source');
    required(label, 'label');
    this.db.prepare('INSERT INTO sources VALUES (?,?,?) ON CONFLICT(namespace,source_id) DO NOTHING').run(ns, sourceId, label);
    this.db.prepare('INSERT INTO heads(namespace,source_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(ns, sourceId);
    return { namespace: ns, sourceId, label };
  }
  acquireLease(ns, sourceId, owner, ttlMs = 30000) {
    namespace(ns); required(owner, 'owner');
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 120000) fail('invalid_lease_ttl');
    return this.transaction(() => {
      const head = this.db.prepare('SELECT * FROM heads WHERE namespace=? AND source_id=?').get(ns, sourceId);
      if (!head) fail('unknown_source', 404);
      const prior = this.db.prepare('SELECT * FROM leases WHERE namespace=? AND source_id=?').get(ns, sourceId);
      const now = this.now();
      if (prior && prior.expires_at > now) fail('lease_busy', 409);
      const generation = (prior?.generation ?? 0) + 1;
      const expiresAt = now + ttlMs;
      this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?) ON CONFLICT(namespace,source_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at').run(ns, sourceId, owner, generation, expiresAt);
      return { namespace: ns, sourceId, owner, generation, expiresAt, expectedHead: head.comparison_head };
    });
  }
  renewLease(lease, ttlMs = 30000) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 120000) fail('invalid_lease_ttl');
    const now = this.now();
    const result = this.db.prepare('UPDATE leases SET expires_at=? WHERE namespace=? AND source_id=? AND owner=? AND generation=? AND expires_at>?').run(now + ttlMs, namespace(lease.namespace), lease.sourceId, lease.owner, lease.generation, now);
    if (result.changes !== 1) fail('stale_lease', 409);
    return { ...lease, expiresAt: now + ttlMs };
  }
  releaseLease(lease) {
    this.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=? AND source_id=? AND owner=? AND generation=?').run(namespace(lease.namespace), lease.sourceId, lease.owner, lease.generation);
  }
  recordObservation({ namespace: ns, sourceId, lease, expectedHead, evidence = [], status, coverage, scope='bounded-v1', runId = randomUUID(), onCommit=null }) {
    namespace(ns);
    if (!lease || lease.namespace !== ns || lease.sourceId !== sourceId) fail('invalid_lease');
    if (!['captured','partial','unavailable','unstable','deferred'].includes(status) || !coverage || !Array.isArray(evidence) || evidence.length > 80) fail('invalid_observation');
    if (status === 'captured' && coverage.complete !== true) fail('coverage_not_complete');
    required(scope,'procedure_scope');
    if(onCommit!==null && typeof onCommit!=='function')fail('invalid_commit_hook');
    required(runId, 'run');
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM leases WHERE namespace=? AND source_id=?').get(ns, sourceId);
      const head = this.db.prepare('SELECT * FROM heads WHERE namespace=? AND source_id=?').get(ns, sourceId);
      if (!current || current.owner !== lease.owner || current.generation !== lease.generation || current.expires_at <= this.now()) fail('stale_lease',409);
      if (!head || head.comparison_head !== expectedHead) fail('head_conflict',409);
      const ids = [],itemRevisions=new Map();
      for (const item of evidence) {
        if (!item || (item.namespace !== undefined && item.namespace !== ns) || (item.sourceId !== undefined && item.sourceId !== sourceId) || (item.source_id !== undefined && item.source_id !== sourceId)) fail('evidence_scope');
        const itemId = item.itemId ?? item.releaseId ?? item.release_id ?? item.id;
        if (!Number.isSafeInteger(itemId) || itemId <= 0) fail('invalid_item');
        if (Object.hasOwn(item,'body') || Object.hasOwn(item,'author') || Object.hasOwn(item,'login')) fail('raw_evidence_forbidden');
        const normalized = validateEvidence(item);
        if(!normalized && !ns.startsWith('test:'))fail('normalized_evidence_required');
        if (item.normalizer_version && !normalized) fail('evidence_digest_mismatch');
        const data = normalized ? item : { ...item, namespace: ns, sourceId, itemId };
        const evidenceDigest = normalized ? item.digest : digest(data);
        const id = normalized ? item.id : evidenceDigest;
        if(itemRevisions.has(itemId) && itemRevisions.get(itemId)!==evidenceDigest)fail('conflicting_observation_identity');
        itemRevisions.set(itemId,evidenceDigest);
        this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(ns,id,sourceId,itemId,evidenceDigest,this.now(),canonical(data));
        if(!ids.includes(id))ids.push(id);
      }
      this.testHooks.afterEvidence?.();
      const payload = { namespace:ns, sourceId, status, coverage, scope, evidenceIds:ids.sort(), runId, previousComparisonHead:expectedHead };
      const observationDigest = digest(payload);
      this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?)').run(ns,runId,sourceId,observationDigest,status,canonical(coverage),this.now(),canonical(payload));
      for(const id of ids) this.db.prepare('INSERT INTO observation_evidence VALUES(?,?,?)').run(ns,runId,id);
      const comparisonHead = status === 'captured' ? runId : head.comparison_head;
      this.db.prepare('UPDATE heads SET latest_attempt=?,comparison_head=?,version=version+1 WHERE namespace=? AND source_id=?').run(runId,comparisonHead,ns,sourceId);
      this.event(ns,'observation_committed',runId,{status,comparisonHead});
      this.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=? AND source_id=? AND generation=?').run(ns,sourceId,lease.generation);
      const callbackResult=onCommit?.({db:this.db,namespace:ns,runId,now:this.now()});
      if(callbackResult && typeof callbackResult.then==='function')fail('asynchronous_transaction_hook_refused');
      return { ...payload, digest:observationDigest, comparisonHead, backend:BACKEND };
    });
  }
  listSources(ns = 'live') {
    namespace(ns);
    return this.db.prepare('SELECT s.*,h.latest_attempt,h.comparison_head,h.version FROM sources s JOIN heads h USING(namespace,source_id) WHERE s.namespace=? ORDER BY source_id').all(ns).map(r => ({namespace:ns,sourceId:r.source_id,label:r.label,latestAttempt:r.latest_attempt ? this.getRun(ns,r.latest_attempt) : null,comparisonHead:r.comparison_head ? this.getRun(ns,r.comparison_head) : null,version:r.version,mode:ns==='live'?'live_source':'synthetic',backend:BACKEND}));
  }
  headVersions(ns) {
    return this.db.prepare('SELECT source_id,comparison_head,version FROM heads WHERE namespace=? ORDER BY source_id').all(namespace(ns));
  }
  assertCurrentHeads(ns,previous) {
    const current=this.headVersions(ns);
    if(canonical(previous)===canonical(current))return;
    const changed=current.filter(row=>!previous.some(old=>canonical(old)===canonical(row))).map(row=>row.source_id);
    const changedSources=this.listSources(ns).filter(source=>changed.includes(source.sourceId)).map(source=>source.label);
    throw Object.assign(new Error('review_required'),{code:'review_required',status:409,changedSources});
  }
  getRun(ns,id) { const row = this.db.prepare('SELECT * FROM observations WHERE namespace=? AND id=?').get(namespace(ns),required(id,'run')); return row ? {...json(row),capturedAt:row.captured_at,digest:row.digest,mode:ns==='live'?'live_source':'synthetic',backend:BACKEND} : null; }
  getEvidence(ns,id) { const row=this.db.prepare('SELECT * FROM evidence WHERE namespace=? AND id=?').get(namespace(ns),required(id,'evidence')); return row ? {namespace:ns,id,digest:row.digest,capturedAt:row.captured_at,data:json(row),backend:BACKEND}:null; }
  prepareBriefing({ namespace:ns, findings, evidenceIds, coverage, method, bundle, beforeRunId, afterRunId, sourceHeads = this.headVersions(ns), watchlistVersion='watchlist-v1', normalizerVersion='normalizer-v1', verifierVersion='verifier-v1', retention='pinned' }) {
    namespace(ns);
    if (!METHODS.includes(method) || !Array.isArray(findings) || !findings.length || findings.length>80 || !Array.isArray(evidenceIds) || !evidenceIds.length || !coverage || typeof coverage.complete !== 'boolean') fail('invalid_briefing');
    if(method!=='deterministic_baseline')fail('inference_receipt_required');
    const sortedIds=[...new Set(evidenceIds)].sort();
    if (!validateBundle(bundle) || bundle.namespace !== ns || bundle.watchlist_version !== watchlistVersion || bundle.normalizer_version !== normalizerVersion || bundle.verifier_version !== verifierVersion) fail('invalid_verification_bundle');
    if(!beforeRunId||!afterRunId)fail('observation_lineage_required');
    const persistedBefore=this.getRun(ns,beforeRunId),persistedAfter=this.getRun(ns,afterRunId);
    const head=this.db.prepare('SELECT * FROM heads WHERE namespace=? AND source_id=?').get(ns,bundle.source_id);
    if(!persistedBefore||!persistedAfter||!head||persistedBefore.sourceId!==bundle.source_id||persistedAfter.sourceId!==bundle.source_id||
      persistedBefore.status!=='captured'||persistedAfter.previousComparisonHead!==beforeRunId||
      persistedAfter.status!==bundle.after.state||bundle.before?.state!==persistedBefore.status||
      persistedBefore.scope!==bundle.before?.scope||persistedAfter.scope!==bundle.after.scope||
      canonical(persistedBefore.evidenceIds)!==canonical(bundle.before.items.map(x=>x.id).sort())||
      canonical(persistedAfter.evidenceIds)!==canonical(bundle.after.items.map(x=>x.id).sort())||
      head.latest_attempt!==afterRunId||head.comparison_head!==(persistedAfter.status==='captured'?afterRunId:beforeRunId)||
      canonical(sourceHeads)!==canonical(this.headVersions(ns)))fail('observation_lineage_mismatch');
    if(coverage.complete!==bundle.after.coverage.procedure_complete)fail('coverage_mismatch');
    if(!coverage.complete && (typeof coverage.warning!=='string'||!coverage.warning))fail('coverage_warning_required');
    const verifiedFindings = findings.map(proposal=>{
      if(proposal.method!==method)fail('method_mismatch');
      const decision=verify(proposal,bundle);
      if(decision.status!=='supported')fail('unsupported_finding');
      const before=bundle.evidence[proposal.before_evidence_id],after=bundle.evidence[proposal.after_evidence_id];
      for(const ref of [before,after].filter(Boolean)){
        const stored=this.getEvidence(ns,ref.id);
        if(!stored || stored.digest!==ref.digest || canonical(stored.data)!==canonical(ref) || !sortedIds.includes(ref.id))fail('verification_evidence_mismatch');
      }
      const rendered=renderFinding(proposal,bundle,decision);
      return {...proposal,sourceId:after.source_id,itemId:after.release_id,beforeEvidenceId:before?.id??null,afterEvidenceId:after.id,
        before:before?.[proposal.field]??null,after:proposal.field==='identity'?after.release_id:after[proposal.field],
        supported:true,text:rendered.text,verificationReceipt:decision.execution_receipt};
    });
    const evidenceDigests=sortedIds.map(id=>{const e=this.getEvidence(ns,id);if(!e)fail('missing_evidence');return {id,digest:e.digest};});
    const payload={namespace:ns,method,findings:verifiedFindings,evidence:evidenceDigests,coverage:{...coverage,observedCoverage:bundle.after.coverage},sourceHeads,watchlistVersion,normalizerVersion,verifierVersion,retention,bundleDigest:bundle.digest,beforeRunId,afterRunId};
    const briefingDigest=digest(payload);
    return this.transaction(()=>{
      this.db.prepare('INSERT INTO briefings VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(ns,briefingDigest,method,canonical(payload),this.now());
      for(const id of sortedIds) this.db.prepare('INSERT INTO briefing_evidence VALUES(?,?,?) ON CONFLICT DO NOTHING').run(ns,briefingDigest,id);
      this.event(ns,'briefing_prepared',briefingDigest,{method});
      return {...payload,digest:briefingDigest,backend:BACKEND};
    });
  }
  listBriefings(ns='live') { return this.db.prepare('SELECT digest FROM briefings WHERE namespace=? ORDER BY created_at DESC,digest').all(namespace(ns)).map(r=>this.getBriefing(ns,r.digest)); }
  getBriefing(ns,briefingDigest) {
    const row=this.db.prepare('SELECT * FROM briefings WHERE namespace=? AND digest=?').get(namespace(ns),required(briefingDigest,'briefing'));
    if(!row)return null;
    const payload=json(row);
    const current=canonical(payload.sourceHeads)===canonical(this.headVersions(ns));
    const publication=this.db.prepare('SELECT publication_key FROM publications WHERE namespace=? AND briefing_digest=?').get(ns,briefingDigest);
    const approval=this.db.prepare('SELECT id,expires_at FROM approvals WHERE namespace=? AND briefing_digest=? ORDER BY approved_at DESC LIMIT 1').get(ns,briefingDigest);
    return {...payload,digest:briefingDigest,createdAt:row.created_at,state:publication?'published':!current?'review_required':approval&&approval.expires_at>this.now()?'approved':'prepared',backend:BACKEND};
  }
  approveBriefing(ns,briefingDigest,{reviewer,scope,ttlMs=300000}={}) {
    namespace(ns);required(reviewer,'reviewer');
    if(scope!==ns)fail('reviewer_scope',403);
    if(!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>3600000)fail('invalid_approval_ttl');
    return this.transaction(()=>{
      const briefing=this.getBriefing(ns,briefingDigest);
      if(!briefing)fail('not_found',404);
      if(briefing.watchlistVersion!=='watchlist-v1'||briefing.normalizerVersion!==NORMALIZER_VERSION||briefing.verifierVersion!==VERIFIER_VERSION)fail('review_required_versions',409);
      this.assertCurrentHeads(ns,briefing.sourceHeads);
      const id=randomUUID(),now=this.now();
      this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run(ns,id,briefingDigest,reviewer,scope,now,now+ttlMs);
      this.event(ns,'briefing_approved',briefingDigest,{approvalId:id,reviewer});
      return {namespace:ns,id,briefingDigest,reviewer,approvedAt:now,expiresAt:now+ttlMs,backend:BACKEND};
    });
  }
  publishBriefing(ns,briefingDigest,{operationKey,approvalId,payloadDigest=briefingDigest}={}) {
    namespace(ns);required(operationKey,'operation');required(briefingDigest,'briefing');required(payloadDigest,'payload_digest');
    const receipt=this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM receipts WHERE namespace=? AND operation_key=?').get(ns,operationKey);
      if(old){if(old.payload_digest!==payloadDigest)fail('operation_conflict',409);const value=json(old);if(value.briefingDigest!==briefingDigest)fail('operation_conflict',409);return {...value,recovered:true};}
      const briefing=this.getBriefing(ns,briefingDigest);
      if(!briefing)fail('not_found',404);
      if(payloadDigest!==briefingDigest)fail('payload_mismatch',409);
      if(briefing.watchlistVersion!=='watchlist-v1'||briefing.normalizerVersion!==NORMALIZER_VERSION||briefing.verifierVersion!==VERIFIER_VERSION)fail('review_required_versions',409);
      this.assertCurrentHeads(ns,briefing.sourceHeads);
      const approval=approvalId ? this.db.prepare('SELECT * FROM approvals WHERE namespace=? AND id=? AND briefing_digest=?').get(ns,approvalId,briefingDigest) : this.db.prepare('SELECT * FROM approvals WHERE namespace=? AND briefing_digest=? ORDER BY approved_at DESC LIMIT 1').get(ns,briefingDigest);
      if(!approval||approval.scope!==ns)fail('approval_required',409);
      if(approval.expires_at<=this.now())fail('approval_expired',409);
      for(const ev of briefing.evidence){const current=this.getEvidence(ns,ev.id);if(!current||current.digest!==ev.digest)fail('missing_evidence',409);}
      const publicationKey=digest({namespace:ns,briefingDigest,payloadDigest});
      const existing=this.db.prepare('SELECT publication_key FROM publications WHERE namespace=? AND publication_key=?').get(ns,publicationKey);
      if(existing)fail('already_published_use_original_operation',409);
      const now=this.now(),receiptId=randomUUID();
      this.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?)').run(ns,publicationKey,briefingDigest,payloadDigest,approval.id,now);
      const value={namespace:ns,receiptId,operationKey,publicationKey,briefingDigest,payloadDigest,publishedAt:now,method:briefing.method,mode:ns==='live'?'live_source':'synthetic',backend:BACKEND};
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(ns,operationKey,payloadDigest,publicationKey,receiptId,now,canonical(value));
      this.event(ns,'publication_committed',publicationKey,{receiptId,briefingDigest});
      return {...value,recovered:false};
    });
    if(!receipt.recovered)this.testHooks.afterPublicationCommit?.(receipt);
    return receipt;
  }
  getReceipt(ns,operationKey){const r=this.db.prepare('SELECT payload FROM receipts WHERE namespace=? AND operation_key=?').get(namespace(ns),required(operationKey,'operation'));return json(r);}
  createDemoSession({clientKey='local-development'}={}) {
    required(clientKey,'client_key');
    return this.transaction(()=>{
      const now=this.now(),windowStart=Math.floor(now/3600000)*3600000;
      this.db.prepare('DELETE FROM session_limits WHERE window_start<?').run(windowStart-3600000);
      const prior=this.db.prepare('SELECT count FROM session_limits WHERE client_key=? AND window_start=?').get(clientKey,windowStart);
      if(prior&&prior.count>=5)fail('session_creation_quota',429);
      if(this.db.prepare('SELECT count(*) AS n FROM sessions').get().n>=1000)fail('session_capacity',429);
      const totalBytes=this.db.prepare('SELECT page_count*page_size AS bytes FROM pragma_page_count(),pragma_page_size()').get().bytes;
      if(totalBytes>50000000)fail('storage_capacity',429);
      this.db.prepare('INSERT INTO session_limits VALUES(?,?,1) ON CONFLICT(client_key,window_start) DO UPDATE SET count=count+1').run(clientKey,windowStart);
      const id=randomUUID(), ns='demo:'+id, capability=randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id,ns,digest(capability),now,now+1800000,60);
      return {id,namespace:ns,capability,expiresAt:now+1800000,mode:'synthetic',method:'deterministic_baseline',backend:BACKEND};
    });
  }
  authorizeDemo(id,capability,consume=true) {
    required(id,'session');
    const row=this.db.prepare('SELECT * FROM sessions WHERE id=? AND namespace=?').get(id,'demo:'+id);
    if(!row||!sameHash(row.capability_hash,digest(typeof capability==='string'?capability:'')))fail('session_not_found',404);
    if(row.expires_at<=this.now())fail('session_expired',410);
    if(consume){const result=this.db.prepare('UPDATE sessions SET remaining=remaining-1 WHERE id=? AND namespace=? AND remaining>0 AND expires_at>?').run(id,row.namespace,this.now());if(result.changes!==1)fail('quota_exhausted',429);}
    return row;
  }
  getDemoSession(id,capability) {
    const s=this.authorizeDemo(id,capability,false);
    const briefings=this.listBriefings(s.namespace);
    const receipts=this.db.prepare('SELECT payload FROM receipts WHERE namespace=? ORDER BY created_at').all(s.namespace).map(r=>json(r));
    return {id,namespace:s.namespace,expiresAt:s.expires_at,remaining:s.remaining,mode:'synthetic',method:'deterministic_baseline',briefings,receipts,backend:BACKEND};
  }
  prepareDemo(id,capability) {
    const s=this.authorizeDemo(id,capability),ns=s.namespace;
    const existing=this.listBriefings(ns);if(existing.length)return existing[0];
    this.registerSource(ns,23,'authored/watchtower-demo');
    const raw={id:2301,tag_name:'v1.0.0',draft:false,prerelease:false,published_at:'2026-10-01T00:00:00Z',created_at:'2026-10-01T00:00:00Z',body:'Authored synthetic demo notes.',assets:[]};
    const before=normalizeRelease(raw,{namespace:ns,sourceId:23});
    let lease=this.acquireLease(ns,23,'demo-baseline');
    this.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,evidence:[before],status:'captured',coverage:{complete:true,scope:'authored two-observation fixture'},runId:'demo-before'});
    const after=normalizeRelease({...raw,tag_name:'v1.1.0'},{namespace:ns,sourceId:23});
    lease=this.acquireLease(ns,23,'demo-change');
    this.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,evidence:[after],status:'captured',coverage:{complete:true,scope:'authored two-observation fixture'},runId:'demo-after'});
    const bundle=makeBundle(makeObservation({namespace:ns,sourceId:23,items:[before]}),makeObservation({namespace:ns,sourceId:23,items:[after]}));
    return this.prepareBriefing({namespace:ns,findings:baseline(bundle).proposals,bundle,beforeRunId:'demo-before',afterRunId:'demo-after',evidenceIds:[before.id,after.id],coverage:{complete:true,scope:'authored two-observation fixture',warning:'Synthetic demo only. Captured tag strings do not establish upgrade safety.'},method:'deterministic_baseline'});
  }
  approveDemo(id,capability,{briefingDigest}={}){const s=this.authorizeDemo(id,capability);return this.approveBriefing(s.namespace,briefingDigest,{reviewer:'synthetic_reviewer',scope:s.namespace});}
  publishDemo(id,capability,{briefingDigest,operationKey}={}){const s=this.authorizeDemo(id,capability);return this.publishBriefing(s.namespace,briefingDigest,{operationKey});}
  pruneEvidence(ns,{keepLatest=2,maxRows=10000,maxBytes=50000000}={}) {
    namespace(ns);
    if(!Number.isInteger(keepLatest)||keepLatest<2||!Number.isInteger(maxRows)||maxRows<1||!Number.isInteger(maxBytes)||maxBytes<1)fail('invalid_retention');
    return this.transaction(()=>{
      const all=this.db.prepare('SELECT * FROM evidence WHERE namespace=? ORDER BY source_id,item_id,captured_at DESC,id DESC').all(ns);
      const pinned=new Set(this.db.prepare('SELECT evidence_id FROM briefing_evidence WHERE namespace=? UNION SELECT oe.evidence_id FROM observation_evidence oe JOIN heads h ON h.namespace=oe.namespace AND (h.latest_attempt=oe.observation_id OR h.comparison_head=oe.observation_id) WHERE oe.namespace=?').all(ns,ns).map(r=>r.evidence_id));
      const counts=new Map(), candidates=[];
      for(const row of all){const key=row.source_id+':'+row.item_id;counts.set(key,(counts.get(key)||0)+1);if(counts.get(key)<=keepLatest)pinned.add(row.id);else if(!pinned.has(row.id))candidates.push(row);}
      const kept=all.filter(r=>pinned.has(r.id));
      const bytes=kept.reduce((a,r)=>a+Buffer.byteLength(r.payload),0);
      if(kept.length>maxRows||bytes>maxBytes)fail('retention_budget_requires_operator',409);
      for(const r of candidates){this.db.prepare('DELETE FROM observation_evidence WHERE namespace=? AND evidence_id=?').run(ns,r.id);this.db.prepare('DELETE FROM evidence WHERE namespace=? AND id=?').run(ns,r.id);}
      this.event(ns,'retention_pruned',ns,{deleted:candidates.length,retained:kept.length,bytes});
      return {namespace:ns,deleted:candidates.length,retained:kept.length,bytes,backend:BACKEND};
    });
  }
}

