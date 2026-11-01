import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresStore,postgresConfig} from '../packages/workflow/postgres.mjs';
import {digest,normalizeRelease,makeObservation,makeBundle,baseline} from '../packages/domain/index.mjs';

test('Postgres config enforces verified TLS without connection-string SSL override',()=>{
  const config=postgresConfig('postgresql://db.example.invalid/watchtower?sslmode=no-verify&sslrootcert=untrusted');
  assert.deepEqual(config.ssl,{rejectUnauthorized:true});assert.equal(config.enableChannelBinding,true);
  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'),false);
  assert.equal(new URL(config.connectionString).searchParams.has('sslrootcert'),false);
  for(const value of [undefined,'bad','http://example/db','postgresql://db-pooler.example.invalid/db'])assert.throws(()=>postgresConfig(value));
});

const connectionString=process.env.WATCHTOWER_TEST_DATABASE_URL;
const code=expected=>error=>error.code===expected;
const scope=()=> 'test:pg_'+randomUUID().replaceAll('-','');
async function seed(s,ns=scope()){
  await s.registerSource(ns,23,'authored/postgres-test');const lease=await s.acquireLease(ns,23,'seed');
  const observation=await s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[{itemId:1,tag:'v1'}],runId:'initial'});
  return {ns,observation};
}
async function demo(s){const session=await s.createDemoSession({clientKey:randomUUID()});const briefing=await s.prepareDemo(session.id,session.capability);const approval=await s.approveDemo(session.id,session.capability,{briefingDigest:briefing.digest});return {session,briefing,approval};}

test('actual PostgreSQL workflow contracts', {skip:!connectionString?'WATCHTOWER_TEST_DATABASE_URL absent; no PostgreSQL execution claimed':false,timeout:180000},async t=>{
  const s=await PostgresStore.create({connectionString,migrate:process.env.WATCHTOWER_TEST_MIGRATE==='1'});
  const other=await PostgresStore.create({connectionString});
  t.after(async()=>{await s.close();await other.close();});

  await t.test('durable immutable evidence is visible on a second connection',async()=>{
    const {ns,observation}=await seed(s);assert.equal((await other.listSources(ns))[0].comparisonHead.runId,'initial');
    assert.equal((await other.getEvidence(ns,observation.evidenceIds[0])).data.tag,'v1');
    await assert.rejects(s.db.query('UPDATE watchtower.evidence_revisions SET metadata=$2 WHERE namespace=$1',[ns,{}]),code('55000'));
  });
  await t.test('competing workers have one active lease generation',async()=>{
    const {ns}=await seed(s);const results=await Promise.allSettled([s.acquireLease(ns,23,'a'),other.acquireLease(ns,23,'b')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'lease_busy');
  });
  await t.test('stale generation and database clock expiry reject returning worker',async()=>{
    const {ns}=await seed(s);const old=await s.acquireLease(ns,23,'old');
    await s.db.query('UPDATE watchtower.source_leases SET expires_at=clock_timestamp()-interval \'1 second\' WHERE namespace=$1',[ns]);
    await assert.rejects(s.renewLease(old),code('stale_lease'));
    const replacement=await other.acquireLease(ns,23,'replacement');assert.equal(replacement.generation,old.generation+1);
    await assert.rejects(s.recordObservation({namespace:ns,sourceId:23,lease:old,expectedHead:old.expectedHead,status:'captured',coverage:{complete:true},runId:'old'}),code('stale_lease'));
  });
  await t.test('expiry during asynchronous commit hook rolls back all durable writes',async()=>{
    const {ns}=await seed(s);const lease=await s.acquireLease(ns,23,'slow',1500);
    await assert.rejects(s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},runId:'expired_inside',onCommit:async({db})=>db.query('SELECT pg_sleep(1.6)')}),code('stale_lease'));
    assert.equal(await other.getRun(ns,'expired_inside'),null);assert.equal((await other.listSources(ns))[0].comparisonHead.runId,'initial');
  });
  await t.test('expected head is independent of current lease ownership',async()=>{
    const {ns}=await seed(s),lease=await s.acquireLease(ns,23,'wrong-head');
    await assert.rejects(s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:null,status:'captured',coverage:{complete:true},runId:'wrong'}),code('head_conflict'));
  });
  await t.test('failed attempts preserve usable comparison head',async()=>{
    const {ns}=await seed(s),lease=await s.acquireLease(ns,23,'failed');
    await s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,status:'unavailable',coverage:{complete:false},runId:'timeout'});
    const source=(await other.listSources(ns))[0];assert.equal(source.latestAttempt.status,'unavailable');assert.equal(source.comparisonHead.runId,'initial');
  });
  await t.test('fault after evidence leaves no evidence observation head or event residue',async()=>{
    const {ns}=await seed(s),lease=await s.acquireLease(ns,23,'fault');s.testHooks.afterEvidence=()=>{throw Error('injected_fault');};
    try{await assert.rejects(s.recordObservation({namespace:ns,sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[{itemId:2,tag:'uncommitted'}],runId:'rollback'}),/injected_fault/);}finally{delete s.testHooks.afterEvidence;}
    assert.equal(await other.getRun(ns,'rollback'),null);assert.equal(Number((await other.db.query('SELECT count(*) AS n FROM watchtower.evidence_revisions WHERE namespace=$1',[ns])).rows[0].n),1);
  });
  await t.test('canonical briefing persists bundle typed proposal verifier receipt and pins',async()=>{
    const {session,briefing}=await demo(s);assert.equal(briefing.backend,'postgres');assert.equal(briefing.method,'deterministic_baseline');
    const r=(await s.db.query('SELECT (SELECT count(*) FROM watchtower.evidence_bundles WHERE namespace=$1) AS bundles,(SELECT count(*) FROM watchtower.proposals WHERE namespace=$1) AS proposals,(SELECT count(*) FROM watchtower.verification_decisions WHERE namespace=$1) AS decisions',[session.namespace])).rows[0];
    assert.equal(Number(r.bundles),1);assert.equal(Number(r.proposals),1);assert.equal(Number(r.decisions),1);
  });
  await t.test('same key concurrent publications commit one receipt and recover identically',async()=>{
    const {session,briefing}=await demo(s),args={operationKey:'concurrent'};
    const a=await Promise.all([s.publishBriefing(session.namespace,briefing.digest,args),other.publishBriefing(session.namespace,briefing.digest,args)]);
    assert.equal(a[0].receiptId,a[1].receiptId);assert.equal(a.filter(r=>r.recovered).length,1);
    assert.equal(Number((await s.db.query('SELECT count(*) AS n FROM watchtower.publications WHERE namespace=$1',[session.namespace])).rows[0].n),1);
  });
  await t.test('postcommit response loss is recovered across connections before stale state checks',async()=>{
    const {session,briefing}=await demo(s);s.testHooks.afterPublicationCommit=()=>{throw Error('lost_response');};
    try{await assert.rejects(s.publishBriefing(session.namespace,briefing.digest,{operationKey:'lost'}),/lost_response/);}finally{delete s.testHooks.afterPublicationCommit;}
    const lease=await s.acquireLease(session.namespace,23,'new-head');await s.recordObservation({namespace:session.namespace,sourceId:23,lease,expectedHead:lease.expectedHead,status:'unavailable',coverage:{complete:false},runId:'new-attempt'});
    const recovered=await other.publishBriefing(session.namespace,briefing.digest,{operationKey:'lost'});assert.equal(recovered.recovered,true);assert.equal(recovered.receiptId,(await s.getReceipt(session.namespace,'lost')).receiptId);
  });
  await t.test('changed payload under same operation key conflicts',async()=>{
    const {session,briefing}=await demo(s);await s.publishBriefing(session.namespace,briefing.digest,{operationKey:'bound'});
    await assert.rejects(other.publishBriefing(session.namespace,briefing.digest,{operationKey:'bound',payloadDigest:digest('changed')}),code('operation_conflict'));
  });
  await t.test('different operation key cannot create second publication or erase receipt',async()=>{
    const {session,briefing}=await demo(s);await s.publishBriefing(session.namespace,briefing.digest,{operationKey:'first'});
    await assert.rejects(other.publishBriefing(session.namespace,briefing.digest,{operationKey:'second'}),code('already_published_use_original_operation'));
    await assert.rejects(s.db.query('DELETE FROM watchtower.publications WHERE namespace=$1',[session.namespace]),code('55000'));
    await assert.rejects(s.db.query('DELETE FROM watchtower.publication_receipts WHERE namespace=$1',[session.namespace]),code('55000'));
  });
  await t.test('reviewer scope must equal namespace',async()=>{
    const {session,briefing}=await demo(s);await assert.rejects(s.approveBriefing(session.namespace,briefing.digest,{reviewer:'wrong',scope:'live'}),code('reviewer_scope'));
  });
  await t.test('new source invalidates previously reviewed source set',async()=>{
    const {session,briefing}=await demo(s);await s.registerSource(session.namespace,24,'authored/added');
    await assert.rejects(s.publishBriefing(session.namespace,briefing.digest,{operationKey:'stale-set'}),error=>error.code==='review_required'&&error.changedSources.length===1&&error.changedSources[0]==='authored/added');
  });
  await t.test('expired approval cannot publish',async()=>{
    const {session,briefing}=await demo(s);const approval=await s.approveBriefing(session.namespace,briefing.digest,{reviewer:'short-lived',scope:session.namespace,ttlMs:1});
    await s.db.query('SELECT pg_sleep(0.01)');await assert.rejects(s.publishBriefing(session.namespace,briefing.digest,{operationKey:'expired',approvalId:approval.id}),code('approval_expired'));
  });
  await t.test('changed normalizer version marks review required and refuses approval',async()=>{
    const {session,briefing}=await demo(s);
    await s.db.query("UPDATE watchtower.watchlists SET normalizer_version='normalizer-future' WHERE namespace=$1 AND id='default'",[session.namespace]);
    assert.equal((await s.getBriefing(session.namespace,briefing.digest)).state,'review_required');
    await assert.rejects(s.approveBriefing(session.namespace,briefing.digest,{reviewer:'reviewer',scope:session.namespace}),code('review_required_versions'));
  });
  await t.test('capabilities and evidence cannot cross namespaces',async()=>{
    const a=await demo(s),b=await s.createDemoSession({clientKey:randomUUID()});
    await assert.rejects(s.getDemoSession(a.session.id,b.capability),code('session_not_found'));
    assert.equal(await s.getEvidence(b.namespace,a.briefing.evidence[0].id),null);assert.equal(await s.getBriefing(b.namespace,a.briefing.digest),null);
  });
  await t.test('session creation quota is atomic across connections',async()=>{
    const clientKey=randomUUID(),results=await Promise.allSettled(Array.from({length:7},(_,i)=>(i%2?s:other).createDemoSession({clientKey})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,5);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='session_creation_quota').length,2);
  });
  await t.test('session mutation quota cannot overconsume under concurrency',async()=>{
    const session=await s.createDemoSession({clientKey:randomUUID()});await s.db.query('UPDATE watchtower.demo_sessions SET mutation_count=59 WHERE namespace=$1 AND id=$2',[session.namespace,session.id]);
    const result=await Promise.allSettled([s.authorizeDemo(session.id,session.capability),other.authorizeDemo(session.id,session.capability)]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.code,'quota_exhausted');
  });
  await t.test('baseline labels cannot be promoted to actual model provenance',async()=>{
    await assert.rejects(s.prepareBriefing({namespace:scope(),findings:[{}],evidenceIds:['x'],coverage:{complete:true},method:'local_agent'}),code('inference_receipt_required'));
  });
  await t.test('unpersisted model-like observation lineage cannot be admitted',async()=>{
    const ns=scope();await s.registerSource(ns,23,'authored/lineage');
    const raw={id:1,tag_name:'v1',draft:false,prerelease:false,published_at:'2026-10-01T00:00:00Z',created_at:'2026-10-01T00:00:00Z',body:'authored',assets:[]};
    const before=normalizeRelease(raw,{namespace:ns,sourceId:23}),after=normalizeRelease({...raw,tag_name:'v2'},{namespace:ns,sourceId:23});
    const bundle=makeBundle(makeObservation({namespace:ns,sourceId:23,items:[before]}),makeObservation({namespace:ns,sourceId:23,items:[after]}));
    await assert.rejects(s.prepareBriefing({namespace:ns,bundle,findings:baseline(bundle).proposals,evidenceIds:[before.id,after.id],coverage:{complete:true},method:'deterministic_baseline',beforeRunId:'fiction-before',afterRunId:'fiction-after'}),code('observation_lineage_mismatch'));
  });
  await t.test('retention preserves pins and refuses an impossible budget atomically',async()=>{
    const {session,briefing}=await demo(s);const before=Number((await s.db.query('SELECT count(*) AS n FROM watchtower.evidence_revisions WHERE namespace=$1',[session.namespace])).rows[0].n);
    await assert.rejects(s.pruneEvidence(session.namespace,{maxRows:1}),code('retention_budget_requires_operator'));
    assert.equal(Number((await s.db.query('SELECT count(*) AS n FROM watchtower.evidence_revisions WHERE namespace=$1',[session.namespace])).rows[0].n),before);
    for(const ev of briefing.evidence)assert.ok(await s.getEvidence(session.namespace,ev.id));
  });
});
