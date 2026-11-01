import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {NORMALIZER_VERSION, VERIFIER_VERSION, METHODS, canonical, digest, normalizeRelease,
  validateEvidence, makeObservation, makeBundle, validateBundle, baseline, verify, renderFinding} from '../domain/index.mjs';

export const BACKEND = 'postgres';
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const required=(value,label)=>{if(typeof value!=='string'||!value.length||value.length>300)fail('invalid_'+label);return value;};
const namespace=value=>{required(value,'namespace');if(!/^(live|synthetic|demo:[a-f0-9-]{36}|test:[a-zA-Z0-9_-]+)$/.test(value))fail('invalid_namespace');return value;};
const ms=value=>value instanceof Date?value.getTime():Date.parse(value);
const sameHash=(a,b)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const ttl=(value,max,kind)=>{if(!Number.isInteger(value)||value<1||value>max)fail('invalid_'+kind+'_ttl');};
const rows=async(db,sql,params=[])=> (await db.query(sql,params)).rows;
const one=async(db,sql,params=[])=> (await rows(db,sql,params))[0]??null;

// Parse credentials without ever printing them. URL SSL settings cannot replace our TLS policy.
export function postgresConfig(connectionString) {
  if(typeof connectionString!=='string'||!connectionString)fail('database_url_required',503);
  let url;try{url=new URL(connectionString);}catch{fail('invalid_database_url',503);}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.pathname.slice(1))fail('invalid_database_url',503);
  if(url.hostname.includes('-pooler'))fail('direct_database_connection_required',503);
  for(const key of [...url.searchParams.keys()])if(/^ssl/i.test(key))url.searchParams.delete(key);
  return {connectionString:url.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true,
    application_name:'watchtower',max:8,idleTimeoutMillis:30000,connectionTimeoutMillis:15000,
    statement_timeout:15000,query_timeout:20000};
}

export class PostgresStore {
  constructor(pool,{testHooks={},ownsPool=false}={}) {
    if(!pool||typeof pool.query!=='function'||typeof pool.connect!=='function')fail('postgres_pool_required');
    this.db=pool;this.backend=BACKEND;this.testHooks=testHooks;this.ownsPool=ownsPool;
  }
  static async create({connectionString=process.env.DATABASE_URL,pool,migrate=false,testHooks={}}={}) {
    let ownsPool=false;
    if(!pool){const config=postgresConfig(connectionString);const {Pool}=await import('pg');pool=new Pool(config);ownsPool=true;}
    const store=new PostgresStore(pool,{testHooks,ownsPool});
    try{if(migrate)await store.migrate();await store.ready();return store;}
    catch(error){await store.close();throw error;}
  }
  async close(){if(this.ownsPool)await this.db.end();}
  async transaction(fn){
    const client=await this.db.connect();
    try{await client.query('BEGIN');await client.query("SET LOCAL search_path=watchtower,pg_catalog");
      await client.query("SET LOCAL lock_timeout='5s'");const value=await fn(client);await client.query('COMMIT');return value;
    }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  }
  async migrate(){
    const client=await this.db.connect();
    try{
      await client.query("SELECT pg_advisory_lock(hashtextextended('watchtower:migrations',0))");
      await client.query('CREATE SCHEMA IF NOT EXISTS watchtower');
      await client.query('CREATE TABLE IF NOT EXISTS watchtower.schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      for(const name of ['001_watchtower.sql','002_runtime_adapter.sql']){
        if(await one(client,'SELECT name FROM watchtower.schema_migrations WHERE name=$1',[name]))continue;
        const source=await readFile(new URL('../../db/migrations/'+name,import.meta.url),'utf8');
        // Put the ledger write in the same transaction as the checked-in migration.
        const sql=source.replace(/COMMIT;\s*$/u,'');
        await client.query(sql);
        await client.query('INSERT INTO watchtower.schema_migrations(name) VALUES($1)',[name]);
        await client.query('COMMIT');
      }
    }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
    finally{try{await client.query("SELECT pg_advisory_unlock(hashtextextended('watchtower:migrations',0))");}finally{client.release();}}
  }
  async now(db=this.db){return Number((await one(db,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).now);}
  async ready(){const r=await one(this.db,"SELECT to_regclass('watchtower.publication_receipts') IS NOT NULL AND to_regclass('watchtower.collector_jobs') IS NOT NULL AS ready");if(!r.ready)fail('postgres_schema_required',503);return true;}
  async event(ns,kind,subject,payload,db=this.db){await db.query('INSERT INTO watchtower.workflow_events(namespace,event_kind,object_id,payload) VALUES($1,$2,$3,$4)',[namespace(ns),kind,subject,payload]);}
  async ensureNamespace(ns,db=this.db){
    namespace(ns);
    await db.query('INSERT INTO watchtower.namespaces(namespace,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[ns,ns==='live'?'live':ns.startsWith('demo:')?'synthetic_demo':'evaluation']);
    await db.query("INSERT INTO watchtower.watchlists VALUES($1,'default',1,$2,$3) ON CONFLICT DO NOTHING",[ns,NORMALIZER_VERSION,VERIFIER_VERSION]);
    const config={version:'watchlist-v1'};
    await db.query("INSERT INTO watchtower.watchlist_versions(namespace,watchlist_id,version,configuration,configuration_digest) VALUES($1,'default',1,$2,$3) ON CONFLICT DO NOTHING",[ns,config,digest(config)]);
  }
  async registerSource(ns,sourceId,label){
    namespace(ns);if(!Number.isSafeInteger(sourceId)||sourceId<=0)fail('invalid_source');required(label,'label');
    return this.transaction(async db=>{await this.ensureNamespace(ns,db);
      await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR UPDATE',[ns]);
      await db.query("INSERT INTO watchtower.sources VALUES($1,$2,$3,'source-policy-v1') ON CONFLICT(namespace,source_id) DO NOTHING",[ns,sourceId,label]);
      await db.query('INSERT INTO watchtower.source_heads(namespace,source_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[ns,sourceId]);
      return {namespace:ns,sourceId,label};});
  }
  async acquireLease(ns,sourceId,owner,ttlMs=30000){
    namespace(ns);required(owner,'owner');ttl(ttlMs,120000,'lease');
    return this.transaction(async db=>{
      const head=await one(db,'SELECT * FROM watchtower.source_heads WHERE namespace=$1 AND source_id=$2 FOR UPDATE',[ns,sourceId]);
      if(!head)fail('unknown_source',404);
      const prior=await one(db,'SELECT *,expires_at>clock_timestamp() AS active FROM watchtower.source_leases WHERE namespace=$1 AND source_id=$2 FOR UPDATE',[ns,sourceId]);
      if(prior?.active)fail('lease_busy',409);
      const generation=Number(prior?.generation??0)+1;
      const row=await one(db,"INSERT INTO watchtower.source_leases(namespace,source_id,generation,owner_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 millisecond') ON CONFLICT(namespace,source_id) DO UPDATE SET generation=EXCLUDED.generation,owner_id=EXCLUDED.owner_id,expires_at=EXCLUDED.expires_at RETURNING expires_at",[ns,sourceId,generation,owner,ttlMs]);
      return {namespace:ns,sourceId,owner,generation,expiresAt:ms(row.expires_at),expectedHead:head.comparison_head_id};
    });
  }
  async renewLease(lease,ttlMs=30000){
    ttl(ttlMs,120000,'lease');
    const r=await one(this.db,"UPDATE watchtower.source_leases SET expires_at=clock_timestamp()+$5*interval '1 millisecond' WHERE namespace=$1 AND source_id=$2 AND owner_id=$3 AND generation=$4 AND expires_at>clock_timestamp() RETURNING expires_at",[namespace(lease.namespace),lease.sourceId,lease.owner,lease.generation,ttlMs]);
    if(!r)fail('stale_lease',409);return {...lease,expiresAt:ms(r.expires_at)};
  }
  async releaseLease(lease){await this.db.query("UPDATE watchtower.source_leases SET expires_at=to_timestamp(0) WHERE namespace=$1 AND source_id=$2 AND owner_id=$3 AND generation=$4",[namespace(lease.namespace),lease.sourceId,lease.owner,lease.generation]);}
  async recordObservation({namespace:ns,sourceId,lease,expectedHead,evidence=[],status,coverage,scope='bounded-v1',runId=randomUUID(),onCommit=null}){
    namespace(ns);if(!lease||lease.namespace!==ns||lease.sourceId!==sourceId)fail('invalid_lease');
    if(!['captured','partial','unavailable','unstable','deferred'].includes(status)||!coverage||!Array.isArray(evidence)||evidence.length>80)fail('invalid_observation');
    if(status==='captured'&&coverage.complete!==true)fail('coverage_not_complete');
    required(scope,'procedure_scope');required(runId,'run');if(onCommit!==null&&typeof onCommit!=='function')fail('invalid_commit_hook');
    return this.transaction(async db=>{
      // All paths lock head before lease so competing workers have one lock order.
      const head=await one(db,'SELECT * FROM watchtower.source_heads WHERE namespace=$1 AND source_id=$2 FOR UPDATE',[ns,sourceId]);
      const current=await one(db,'SELECT *,expires_at>clock_timestamp() AS active FROM watchtower.source_leases WHERE namespace=$1 AND source_id=$2 FOR UPDATE',[ns,sourceId]);
      if(!current||current.owner_id!==lease.owner||Number(current.generation)!==lease.generation||!current.active)fail('stale_lease',409);
      if(!head||head.comparison_head_id!==expectedHead)fail('head_conflict',409);
      const ids=[],itemRevisions=new Map();
      for(const item of evidence){
        if(!item||(item.namespace!==undefined&&item.namespace!==ns)||(item.sourceId!==undefined&&item.sourceId!==sourceId)||(item.source_id!==undefined&&item.source_id!==sourceId))fail('evidence_scope');
        const itemId=item.itemId??item.releaseId??item.release_id??item.id;
        if(!Number.isSafeInteger(itemId)||itemId<=0)fail('invalid_item');
        if(['body','author','login','avatar_url'].some(key=>Object.hasOwn(item,key)))fail('raw_evidence_forbidden');
        const normalized=validateEvidence(item);if(!normalized&&!ns.startsWith('test:'))fail('normalized_evidence_required');
        if(item.normalizer_version&&!normalized)fail('evidence_digest_mismatch');
        const data=normalized?item:{...item,namespace:ns,sourceId,itemId};const evidenceDigest=normalized?item.digest:digest(data),id=normalized?item.id:evidenceDigest;
        if(itemRevisions.has(itemId)&&itemRevisions.get(itemId)!==evidenceDigest)fail('conflicting_observation_identity');itemRevisions.set(itemId,evidenceDigest);
        await db.query('INSERT INTO watchtower.evidence_revisions(namespace,id,source_id,release_id,digest,normalizer_version,metadata,captured_at,byte_count) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8) ON CONFLICT DO NOTHING',[ns,id,sourceId,itemId,evidenceDigest,NORMALIZER_VERSION,data,Buffer.byteLength(canonical(data))]);
        const persisted=await this.getEvidence(ns,id,db);if(!persisted||persisted.digest!==evidenceDigest||canonical(persisted.data)!==canonical(data))fail('evidence_digest_mismatch');
        if(!ids.includes(id))ids.push(id);
      }
      await this.testHooks.afterEvidence?.();
      const payload={namespace:ns,sourceId,status,coverage,scope,evidenceIds:ids.sort(),runId,previousComparisonHead:expectedHead},observationDigest=digest(payload);
      await db.query("INSERT INTO watchtower.collection_runs(namespace,id,watchlist_id,watchlist_version,run_key,plan_digest,state,finished_at,attempt_budget) VALUES($1,$2,'default',1,$2,$3,$4,clock_timestamp(),24)",[ns,runId,digest({namespace:ns,sourceId,runId,scope}),status]);
      await db.query('INSERT INTO watchtower.observations(namespace,id,source_id,run_id,digest,state,coverage,checked_at,content_captured_at,procedure_version,lease_generation,runtime_payload) VALUES($1,$2,$3,$2,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7,$8,$9)',[ns,runId,sourceId,observationDigest,status,coverage,scope,lease.generation,payload]);
      for(const id of ids)await db.query('INSERT INTO watchtower.observation_evidence VALUES($1,$2,$3)',[ns,runId,id]);
      const comparisonHead=status==='captured'?runId:head.comparison_head_id;
      // Recheck database time immediately before committing any head change.
      const fence=await one(db,'SELECT expires_at>clock_timestamp() AS active FROM watchtower.source_leases WHERE namespace=$1 AND source_id=$2 AND generation=$3',[ns,sourceId,lease.generation]);
      if(!fence?.active)fail('stale_lease',409);
      await db.query('UPDATE watchtower.source_heads SET latest_attempt_id=$3,comparison_head_id=$4,version=version+1 WHERE namespace=$1 AND source_id=$2',[ns,sourceId,runId,comparisonHead]);
      await this.event(ns,'observation_committed',runId,{status,comparisonHead},db);
      await onCommit?.({db,namespace:ns,runId,now:await this.now(db)});
      const finalFence=await one(db,'SELECT expires_at>clock_timestamp() AS active FROM watchtower.source_leases WHERE namespace=$1 AND source_id=$2 AND generation=$3',[ns,sourceId,lease.generation]);
      if(!finalFence?.active)fail('stale_lease',409);
      await db.query('UPDATE watchtower.source_leases SET expires_at=to_timestamp(0) WHERE namespace=$1 AND source_id=$2 AND generation=$3',[ns,sourceId,lease.generation]);
      return {...payload,digest:observationDigest,comparisonHead,backend:BACKEND};
    });
  }
  async listSources(ns='live'){
    const result=await rows(this.db,'SELECT s.*,h.latest_attempt_id,h.comparison_head_id,h.version FROM watchtower.sources s JOIN watchtower.source_heads h USING(namespace,source_id) WHERE s.namespace=$1 ORDER BY source_id',[namespace(ns)]);
    return Promise.all(result.map(async r=>({namespace:ns,sourceId:Number(r.source_id),label:r.repository_label,latestAttempt:r.latest_attempt_id?await this.getRun(ns,r.latest_attempt_id):null,comparisonHead:r.comparison_head_id?await this.getRun(ns,r.comparison_head_id):null,version:Number(r.version),mode:ns==='live'?'live_source':'synthetic',backend:BACKEND})));
  }
  async headVersions(ns,db=this.db,{lock=false}={}){return (await rows(db,'SELECT source_id,comparison_head_id AS comparison_head,version FROM watchtower.source_heads WHERE namespace=$1 ORDER BY source_id'+(lock?' FOR SHARE':''),[namespace(ns)])).map(r=>({...r,source_id:Number(r.source_id),version:Number(r.version)}));}
  async getRun(ns,id,db=this.db){const r=await one(db,'SELECT * FROM watchtower.observations WHERE namespace=$1 AND id=$2',[namespace(ns),required(id,'run')]);return r?{...r.runtime_payload,capturedAt:ms(r.checked_at),digest:r.digest,mode:ns==='live'?'live_source':'synthetic',backend:BACKEND}:null;}
  async getEvidence(ns,id,db=this.db){const r=await one(db,'SELECT * FROM watchtower.evidence_revisions WHERE namespace=$1 AND id=$2',[namespace(ns),required(id,'evidence')]);return r?{namespace:ns,id,digest:r.digest,capturedAt:ms(r.captured_at),data:r.metadata,backend:BACKEND}:null;}
  async prepareBriefing({namespace:ns,findings,evidenceIds,coverage,method,bundle,beforeRunId,afterRunId,sourceHeads,watchlistVersion='watchlist-v1',normalizerVersion=NORMALIZER_VERSION,verifierVersion=VERIFIER_VERSION,retention='pinned'}){
    namespace(ns);
    if(!METHODS.includes(method)||!Array.isArray(findings)||!findings.length||findings.length>80||!Array.isArray(evidenceIds)||!evidenceIds.length||!coverage||typeof coverage.complete!=='boolean')fail('invalid_briefing');
    if(method!=='deterministic_baseline')fail('inference_receipt_required');
    if(!validateBundle(bundle)||bundle.namespace!==ns||bundle.watchlist_version!==watchlistVersion||bundle.normalizer_version!==normalizerVersion||bundle.verifier_version!==verifierVersion)fail('invalid_verification_bundle');
    if(!beforeRunId||!afterRunId)fail('observation_lineage_required');
    return this.transaction(async db=>{
      await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR SHARE',[ns]);
      const currentHeads=await this.headVersions(ns,db,{lock:true});sourceHeads??=currentHeads;
      const persistedBefore=await this.getRun(ns,beforeRunId,db),persistedAfter=await this.getRun(ns,afterRunId,db);
      const head=await one(db,'SELECT * FROM watchtower.source_heads WHERE namespace=$1 AND source_id=$2',[ns,bundle.source_id]);
      if(!persistedBefore||!persistedAfter||!head||persistedBefore.sourceId!==bundle.source_id||persistedAfter.sourceId!==bundle.source_id||persistedBefore.status!=='captured'||persistedAfter.previousComparisonHead!==beforeRunId||persistedAfter.status!==bundle.after.state||bundle.before?.state!==persistedBefore.status||persistedBefore.scope!==bundle.before?.scope||persistedAfter.scope!==bundle.after.scope||canonical(persistedBefore.evidenceIds)!==canonical(bundle.before.items.map(x=>x.id).sort())||canonical(persistedAfter.evidenceIds)!==canonical(bundle.after.items.map(x=>x.id).sort())||head.latest_attempt_id!==afterRunId||head.comparison_head_id!==(persistedAfter.status==='captured'?afterRunId:beforeRunId)||canonical(sourceHeads)!==canonical(currentHeads))fail('observation_lineage_mismatch');
      if(coverage.complete!==bundle.after.coverage.procedure_complete)fail('coverage_mismatch');
      if(!coverage.complete&&(typeof coverage.warning!=='string'||!coverage.warning))fail('coverage_warning_required');
      const sortedIds=[...new Set(evidenceIds)].sort(),verifiedFindings=[];
      await db.query('INSERT INTO watchtower.evidence_bundles(namespace,id,digest,manifest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ns,bundle.id,bundle.digest,bundle]);
      for(const proposal of findings){
        if(proposal.method!==method)fail('method_mismatch');const decision=verify(proposal,bundle);if(decision.status!=='supported')fail('unsupported_finding');
        const before=bundle.evidence[proposal.before_evidence_id],after=bundle.evidence[proposal.after_evidence_id];
        for(const ref of [before,after].filter(Boolean)){const stored=await this.getEvidence(ns,ref.id,db);if(!stored||stored.digest!==ref.digest||canonical(stored.data)!==canonical(ref)||!sortedIds.includes(ref.id))fail('verification_evidence_mismatch');}
        const rendered=renderFinding(proposal,bundle,decision);
        // Persist the typed proposal and independently recomputed predicate receipt, not only rendered prose.
        await db.query('INSERT INTO watchtower.candidate_changes(namespace,id,source_id,release_id,before_evidence_id,after_evidence_id,finding_kind,deduplication_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[ns,proposal.candidate_id,after.source_id,after.release_id,before?.id??null,after.id,proposal.kind,digest({candidate_id:proposal.candidate_id})]);
        await db.query('INSERT INTO watchtower.bundle_candidates VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ns,bundle.id,proposal.candidate_id]);
        const proposalDigest=digest(proposal),proposalId='proposal_'+proposalDigest;
        await db.query('INSERT INTO watchtower.proposals(namespace,id,candidate_id,agent_run_id,method,proposal_digest,typed_payload) VALUES($1,$2,$3,NULL,$4,$5,$6) ON CONFLICT DO NOTHING',[ns,proposalId,proposal.candidate_id,method,proposalDigest,proposal]);
        await db.query('INSERT INTO watchtower.verification_decisions(namespace,id,proposal_id,bundle_id,verifier_version,decision,predicate,operands,reason_code,execution_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',[ns,'verification_'+decision.execution_receipt,proposalId,bundle.id,VERIFIER_VERSION,decision.status,proposal.kind,decision.operands,decision.reason,decision.execution_receipt]);
        verifiedFindings.push({...proposal,sourceId:after.source_id,itemId:after.release_id,beforeEvidenceId:before?.id??null,afterEvidenceId:after.id,before:before?.[proposal.field]??null,after:proposal.field==='identity'?after.release_id:after[proposal.field],supported:true,text:rendered.text,verificationReceipt:decision.execution_receipt});
      }
      const evidenceDigests=[];for(const id of sortedIds){const e=await this.getEvidence(ns,id,db);if(!e)fail('missing_evidence');evidenceDigests.push({id,digest:e.digest});}
      const payload={namespace:ns,method,findings:verifiedFindings,evidence:evidenceDigests,coverage:{...coverage,observedCoverage:bundle.after.coverage},sourceHeads,watchlistVersion,normalizerVersion,verifierVersion,retention,bundleDigest:bundle.digest,beforeRunId,afterRunId},briefingDigest=digest(payload);
      await db.query("INSERT INTO watchtower.briefing_revisions(namespace,digest,payload_digest,watchlist_id,watchlist_version,normalizer_version,verifier_version,method,payload,coverage_warning_digest,retention_requirements) VALUES($1,$2,$2,'default',1,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",[ns,briefingDigest,normalizerVersion,verifierVersion,method,payload,digest(coverage.warning??''),{mode:retention,evidence:sortedIds}]);
      for(const id of sortedIds)await db.query('INSERT INTO watchtower.briefing_evidence VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ns,briefingDigest,id]);
      for(const head of sourceHeads)if(head.comparison_head!==null)await db.query('INSERT INTO watchtower.briefing_source_dependencies VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ns,briefingDigest,head.source_id,head.comparison_head,head.version]);
      await this.event(ns,'briefing_prepared',briefingDigest,{method},db);return {...payload,digest:briefingDigest,backend:BACKEND};
    });
  }
  async listBriefings(ns='live'){return Promise.all((await rows(this.db,'SELECT digest FROM watchtower.briefing_revisions WHERE namespace=$1 ORDER BY prepared_at DESC,digest',[namespace(ns)])).map(r=>this.getBriefing(ns,r.digest)));}
  async getBriefing(ns,briefingDigest,db=this.db){
    const row=await one(db,'SELECT * FROM watchtower.briefing_revisions WHERE namespace=$1 AND digest=$2',[namespace(ns),required(briefingDigest,'briefing')]);if(!row)return null;
    const watchlist=await one(db,"SELECT current_version,normalizer_version,verifier_version FROM watchtower.watchlists WHERE namespace=$1 AND id='default'",[ns]);
    const current=canonical(row.payload.sourceHeads)===canonical(await this.headVersions(ns,db))&&
      row.payload.watchlistVersion==='watchlist-v1'&&row.payload.normalizerVersion===NORMALIZER_VERSION&&row.payload.verifierVersion===VERIFIER_VERSION&&
      watchlist?.current_version===1&&watchlist.normalizer_version===NORMALIZER_VERSION&&watchlist.verifier_version===VERIFIER_VERSION;
    const publication=await one(db,'SELECT id FROM watchtower.publications WHERE namespace=$1 AND briefing_digest=$2',[ns,briefingDigest]);
    const approval=await one(db,"SELECT id,expires_at>clock_timestamp() AS active FROM watchtower.approvals WHERE namespace=$1 AND briefing_digest=$2 AND decision='approved' ORDER BY approved_at DESC LIMIT 1",[ns,briefingDigest]);
    return {...row.payload,digest:briefingDigest,createdAt:ms(row.prepared_at),state:publication?'published':!current?'review_required':approval?.active?'approved':'prepared',backend:BACKEND};
  }
  async checkCurrent(ns,briefing,db){
    await db.query('SELECT namespace FROM watchtower.namespaces WHERE namespace=$1 FOR SHARE',[ns]);
    if(briefing.watchlistVersion!=='watchlist-v1'||briefing.normalizerVersion!==NORMALIZER_VERSION||briefing.verifierVersion!==VERIFIER_VERSION)fail('review_required_versions',409);
    const watchlist=await one(db,"SELECT * FROM watchtower.watchlists WHERE namespace=$1 AND id='default' FOR SHARE",[ns]);
    if(!watchlist||watchlist.current_version!==1||watchlist.normalizer_version!==NORMALIZER_VERSION||watchlist.verifier_version!==VERIFIER_VERSION)fail('review_required_versions',409);
      const current=await this.headVersions(ns,db,{lock:true});
      if(canonical(briefing.sourceHeads)!==canonical(current)){
        const changed=current.filter(row=>!briefing.sourceHeads.some(old=>canonical(old)===canonical(row))).map(row=>row.source_id);
        const labels=changed.length?await rows(db,'SELECT repository_label FROM watchtower.sources WHERE namespace=$1 AND source_id=ANY($2::bigint[]) ORDER BY source_id LIMIT 80',[ns,changed]):[];
        throw Object.assign(new Error('review_required'),{code:'review_required',status:409,changedSources:labels.map(row=>row.repository_label)});
      }
  }
  async approveBriefing(ns,briefingDigest,{reviewer,scope,ttlMs=300000}={}){
    namespace(ns);required(reviewer,'reviewer');if(scope!==ns)fail('reviewer_scope',403);ttl(ttlMs,3600000,'approval');
    return this.transaction(async db=>{
      const briefing=await this.getBriefing(ns,briefingDigest,db);if(!briefing)fail('not_found',404);await this.checkCurrent(ns,briefing,db);
      const id=randomUUID(),r=await one(db,"INSERT INTO watchtower.approvals(namespace,id,briefing_digest,reviewer_scope,decision,approved_at,expires_at,reviewer) VALUES($1,$2,$3,$1,'approved',clock_timestamp(),clock_timestamp()+$5*interval '1 millisecond',$4) RETURNING approved_at,expires_at",[ns,id,briefingDigest,reviewer,ttlMs]);
      await this.event(ns,'briefing_approved',briefingDigest,{approvalId:id,reviewer},db);
      return {namespace:ns,id,briefingDigest,reviewer,approvedAt:ms(r.approved_at),expiresAt:ms(r.expires_at),backend:BACKEND};
    });
  }
  async publishBriefing(ns,briefingDigest,{operationKey,approvalId,payloadDigest=briefingDigest}={}){
    namespace(ns);required(operationKey,'operation');required(briefingDigest,'briefing');required(payloadDigest,'payload_digest');
    if(operationKey.length>256)fail('invalid_operation');
    const receipt=await this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ns+':operation:'+operationKey]);
      const old=await one(db,'SELECT i.briefing_digest,i.payload_digest,r.payload FROM watchtower.idempotency_records i JOIN watchtower.publication_receipts r ON r.namespace=i.namespace AND r.id=i.receipt_id WHERE i.namespace=$1 AND i.operation_key=$2',[ns,operationKey]);
      if(old){if(old.payload_digest!==payloadDigest||old.briefing_digest!==briefingDigest)fail('operation_conflict',409);return {...old.payload,recovered:true};}
      const briefing=await this.getBriefing(ns,briefingDigest,db);if(!briefing)fail('not_found',404);if(payloadDigest!==briefingDigest)fail('payload_mismatch',409);await this.checkCurrent(ns,briefing,db);
      const approval=approvalId?await one(db,"SELECT *,expires_at>clock_timestamp() AS active FROM watchtower.approvals WHERE namespace=$1 AND id=$2 AND briefing_digest=$3 AND decision='approved'",[ns,approvalId,briefingDigest]):await one(db,"SELECT *,expires_at>clock_timestamp() AS active FROM watchtower.approvals WHERE namespace=$1 AND briefing_digest=$2 AND decision='approved' ORDER BY approved_at DESC LIMIT 1",[ns,briefingDigest]);
      if(!approval||approval.reviewer_scope!==ns)fail('approval_required',409);if(!approval.active)fail('approval_expired',409);
      for(const ev of briefing.evidence){const e=await this.getEvidence(ns,ev.id,db);if(!e||e.digest!==ev.digest)fail('missing_evidence',409);}
      const publicationKey=digest({namespace:ns,briefingDigest,payloadDigest});
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ns+':publication:'+publicationKey]);
      if(await one(db,'SELECT id FROM watchtower.publications WHERE namespace=$1 AND id=$2',[ns,publicationKey]))fail('already_published_use_original_operation',409);
      // Approval validity is checked again at the final mutation boundary using database time.
      const fresh=await one(db,'SELECT expires_at>clock_timestamp() AS active FROM watchtower.approvals WHERE namespace=$1 AND id=$2',[ns,approval.id]);if(!fresh?.active)fail('approval_expired',409);
      const now=await this.now(db),receiptId=randomUUID(),value={namespace:ns,receiptId,operationKey,publicationKey,briefingDigest,payloadDigest,publishedAt:now,method:briefing.method,mode:ns==='live'?'live_source':'synthetic',backend:BACKEND};
      await db.query('INSERT INTO watchtower.publications(namespace,id,briefing_digest,payload_digest,approval_id,published_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000))',[ns,publicationKey,briefingDigest,payloadDigest,approval.id,now]);
      await db.query('INSERT INTO watchtower.publication_receipts(namespace,id,publication_id,receipt_digest,committed_at,payload) VALUES($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6)',[ns,receiptId,publicationKey,digest(value),now,value]);
      await db.query('INSERT INTO watchtower.idempotency_records VALUES($1,$2,$3,$4,$5)',[ns,operationKey,briefingDigest,payloadDigest,receiptId]);
      await this.event(ns,'publication_committed',publicationKey,{receiptId,briefingDigest},db);return {...value,recovered:false};
    });
    if(!receipt.recovered)await this.testHooks.afterPublicationCommit?.(receipt);return receipt;
  }
  async getReceipt(ns,operationKey){return (await one(this.db,'SELECT r.payload FROM watchtower.idempotency_records i JOIN watchtower.publication_receipts r ON r.namespace=i.namespace AND r.id=i.receipt_id WHERE i.namespace=$1 AND i.operation_key=$2',[namespace(ns),required(operationKey,'operation')]))?.payload??null;}
  async createDemoSession({clientKey='local-development'}={}){
    required(clientKey,'client_key');return this.transaction(async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('watchtower:demo-capacity',0))");
      const now=await this.now(db),windowStart=Math.floor(now/3600000)*3600000;
      await db.query("DELETE FROM watchtower.demo_session_limits WHERE namespace='system:demo_quota' AND window_start<$1",[windowStart-3600000]);
      const prior=await one(db,"SELECT count FROM watchtower.demo_session_limits WHERE namespace='system:demo_quota' AND client_key=$1 AND window_start=$2",[clientKey,windowStart]);if(prior?.count>=5)fail('session_creation_quota',429);
      if(Number((await one(db,'SELECT count(*) AS n FROM watchtower.demo_sessions')).n)>=1000)fail('session_capacity',429);
      const size=await one(db,"SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='watchtower' AND c.relkind='r'");if(Number(size.bytes)>50000000)fail('storage_capacity',429);
      await db.query("INSERT INTO watchtower.demo_session_limits VALUES('system:demo_quota',$1,$2,1) ON CONFLICT(namespace,client_key,window_start) DO UPDATE SET count=demo_session_limits.count+1",[clientKey,windowStart]);
      const id=randomUUID(),ns='demo:'+id,capability=randomBytes(32).toString('hex');await this.ensureNamespace(ns,db);
      await db.query("INSERT INTO watchtower.demo_sessions(namespace,id,capability_digest,expires_at,mutation_count,mutation_limit) VALUES($1,$2,$3,to_timestamp($4::double precision/1000),0,60)",[ns,id,digest(capability),now+1800000]);
      return {id,namespace:ns,capability,expiresAt:now+1800000,mode:'synthetic',method:'deterministic_baseline',backend:BACKEND};
    });
  }
  async authorizeDemo(id,capability,consume=true){
    required(id,'session');return this.transaction(async db=>{
      const r=await one(db,'SELECT *,expires_at>clock_timestamp() AS active FROM watchtower.demo_sessions WHERE namespace=$1 AND id=$2 FOR UPDATE',['demo:'+id,id]);
      if(!r||!sameHash(r.capability_digest,digest(typeof capability==='string'?capability:'')))fail('session_not_found',404);
      if(!r.active)fail('session_expired',410);if(consume){if(r.mutation_count>=r.mutation_limit)fail('quota_exhausted',429);await db.query('UPDATE watchtower.demo_sessions SET mutation_count=mutation_count+1 WHERE namespace=$1 AND id=$2',[r.namespace,id]);}
      return {...r,expires_at:ms(r.expires_at),remaining:r.mutation_limit-r.mutation_count};
    });
  }
  async getDemoSession(id,capability){const s=await this.authorizeDemo(id,capability,false);return {id,namespace:s.namespace,expiresAt:s.expires_at,remaining:s.remaining,mode:'synthetic',method:'deterministic_baseline',briefings:await this.listBriefings(s.namespace),receipts:(await rows(this.db,'SELECT payload FROM watchtower.publication_receipts WHERE namespace=$1 ORDER BY committed_at',[s.namespace])).map(r=>r.payload),backend:BACKEND};}
  async prepareDemo(id,capability){
    const s=await this.authorizeDemo(id,capability),ns=s.namespace,existing=await this.listBriefings(ns);if(existing.length)return existing[0];
    await this.registerSource(ns,23,'authored/watchtower-demo');
    const raw={id:2301,tag_name:'v1.0.0',draft:false,prerelease:false,published_at:'2026-10-01T00:00:00Z',created_at:'2026-10-01T00:00:00Z',body:'Authored synthetic demo notes.',assets:[]};
    const before=normalizeRelease(raw,{namespace:ns,sourceId:23}),after=normalizeRelease({...raw,tag_name:'v1.1.0'},{namespace:ns,sourceId:23});
    // Retry can resume after either durable observation without fabricating another revision.
    for(const [runId,item,owner] of [['demo-before',before,'demo-baseline'],['demo-after',after,'demo-change']]){
      if(await this.getRun(ns,runId))continue;const lease=await this.acquireLease(ns,23,owner);
      await this.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,evidence:[item],status:'captured',coverage:{complete:true,scope:'authored two-observation fixture'},runId});
    }
    const bundle=makeBundle(makeObservation({namespace:ns,sourceId:23,items:[before]}),makeObservation({namespace:ns,sourceId:23,items:[after]}));
    return this.prepareBriefing({namespace:ns,findings:baseline(bundle).proposals,bundle,beforeRunId:'demo-before',afterRunId:'demo-after',evidenceIds:[before.id,after.id],coverage:{complete:true,scope:'authored two-observation fixture',warning:'Synthetic demo only. Captured tag strings do not establish upgrade safety.'},method:'deterministic_baseline'});
  }
  async approveDemo(id,capability,{briefingDigest}={}){const s=await this.authorizeDemo(id,capability);return this.approveBriefing(s.namespace,briefingDigest,{reviewer:'synthetic_reviewer',scope:s.namespace});}
  async publishDemo(id,capability,{briefingDigest,operationKey}={}){const s=await this.authorizeDemo(id,capability);return this.publishBriefing(s.namespace,briefingDigest,{operationKey});}
  async pruneEvidence(ns,{keepLatest=2,maxRows=10000,maxBytes=50000000}={}){
    namespace(ns);if(!Number.isInteger(keepLatest)||keepLatest<2||!Number.isInteger(maxRows)||maxRows<1||!Number.isInteger(maxBytes)||maxBytes<1)fail('invalid_retention');
    return this.transaction(async db=>{
      await this.headVersions(ns,db,{lock:true});
      const all=await rows(db,'SELECT * FROM watchtower.evidence_revisions WHERE namespace=$1 ORDER BY source_id,release_id,captured_at DESC,id DESC FOR UPDATE',[ns]);
      const pins=await rows(db,'SELECT evidence_id FROM watchtower.briefing_evidence WHERE namespace=$1 UNION SELECT oe.evidence_id FROM watchtower.observation_evidence oe JOIN watchtower.source_heads h ON h.namespace=oe.namespace AND (h.latest_attempt_id=oe.observation_id OR h.comparison_head_id=oe.observation_id) WHERE oe.namespace=$1 UNION SELECT before_evidence_id AS evidence_id FROM watchtower.candidate_changes WHERE namespace=$1 UNION SELECT after_evidence_id AS evidence_id FROM watchtower.candidate_changes WHERE namespace=$1',[ns]);
      const pinned=new Set(pins.map(r=>r.evidence_id)),counts=new Map();for(const r of all){const key=r.source_id+':'+r.release_id;counts.set(key,(counts.get(key)??0)+1);if(counts.get(key)<=keepLatest)pinned.add(r.id);}
      const kept=all.filter(r=>pinned.has(r.id)),deleted=all.filter(r=>!pinned.has(r.id)),bytes=kept.reduce((sum,r)=>sum+Number(r.byte_count),0);
      if(kept.length>maxRows||bytes>maxBytes)fail('retention_budget_requires_operator',409);
      for(const r of deleted){await db.query('DELETE FROM watchtower.observation_evidence WHERE namespace=$1 AND evidence_id=$2',[ns,r.id]);await db.query('DELETE FROM watchtower.evidence_revisions WHERE namespace=$1 AND id=$2',[ns,r.id]);}
      await this.event(ns,'retention_pruned',ns,{deleted:deleted.length,retained:kept.length,bytes},db);return {namespace:ns,deleted:deleted.length,retained:kept.length,bytes,backend:BACKEND};
    });
  }
}
