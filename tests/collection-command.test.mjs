import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/workflow/store.mjs';
import { collectionPreflight, runCollection } from '../scripts/collect.mjs';
import { PersistentCache, installCollectorTables } from '../packages/collector/persistent-cache.mjs';
import { createSource, cacheKey, endpoint } from '../packages/collector/index.mjs';
import { normalizeRelease } from '../packages/domain/index.mjs';

const source = createSource('vercel/eve',1001);
const raw = (id=101) => ({id,tag_name:'v1',draft:false,prerelease:false,published_at:'2026-11-01T10:00:00Z',created_at:'2026-10-31T10:00:00Z',body:'Authored synthetic fixture only.',assets:[]});
const response = (body,status=200,extra={}) => ({status,headers:{'content-type':'application/json',...extra},body});
function temporary(t) {
  const folder=mkdtempSync(join(tmpdir(),'watchtower-collect-')); const path=join(folder,'state.sqlite');
  const opened=[];
  t.after(()=>{for(const s of opened)try{s.close();}catch{}
    if(!resolve(folder).startsWith(resolve(tmpdir())+sep)||!basename(folder).startsWith('watchtower-collect-'))throw new Error('unsafe_test_cleanup');
    rmSync(folder,{recursive:true,force:true});});
  return {open(){const s=new Store(path);opened.push(s);return s;},path};
}

test('preflight records unresolved fixed identities and refuses malformed or empty scope',()=>{
  const config=JSON.parse(readFileSync(new URL('../config/watchlist.json',import.meta.url),'utf8'));
  const report=collectionPreflight(config);
  assert.equal(report.sources.length,4);assert.equal(report.ready_for_live_collection,false);
  assert.deepEqual(report.blockers,['repository_numeric_identities_unresolved','rest_api_version_unverified','direct_postgres_adapter_unavailable']);
  assert.equal(report.requests_attempted,0);assert.equal(report.workflow_dispatch_succeeded,false);
  assert.throws(()=>collectionPreflight({...config,sources:[{label:'attacker/repo'}]}),/invalid_fixed_watchlist/);
  assert.throws(()=>collectionPreflight({}),/invalid_fixed_watchlist/);
});
test('local command refuses live namespace and arbitrary source before requests',async t=>{
  const store=temporary(t).open();let calls=0;
  const transport=async()=>{calls++;return response([]);};
  await assert.rejects(runCollection({store,namespace:'live',sources:[source],runKey:'live',transport}),/local_collection_namespace_refused/);
  await assert.rejects(runCollection({store,namespace:'test:scope',sources:[{label:'other/source',sourceId:1}],runKey:'bad',transport}),/SOURCE_NOT_ALLOWLISTED/);
  await assert.rejects(runCollection({store,namespace:'test:scope',sources:[],runKey:'empty',transport}),/invalid_collection_sources/);
  assert.equal(calls,0);
});
test('persistent scoped cache survives fresh connection, revalidation, and failed later collection',async t=>{
  const temp=temporary(t);const a=temp.open();const ns='test:cache';
  const first=await runCollection({store:a,namespace:ns,sources:[source],runKey:'first',now:'2026-11-01T12:00:00Z',transport:async()=>response([raw()],200,{etag:'opaque-one'})});
  assert.equal(first.state,'captured');assert.equal(first.attempted,1);
  const b=temp.open();const key=cacheKey({source,path:endpoint(source,{page:1}),namespace:ns});
  const persisted=new PersistentCache(b,ns,1001).get(key);assert.equal(persisted.etag,'opaque-one');
  assert.equal(new PersistentCache(b,'test:foreign',1001).get(key),undefined);
  let conditional=false;
  const second=await runCollection({store:b,namespace:ns,sources:[source],runKey:'second',now:'2026-11-01T13:00:00Z',transport:async request=>{
    if(request.url.includes('?')){conditional=request.headers['If-None-Match']==='opaque-one';return response('',304);}
    return response(raw());
  }});
  assert.equal(conditional,true);assert.equal(second.state,'captured');
  const secondHead=b.listSources(ns)[0].comparisonHead.runId;
  const c=temp.open();const updated=new PersistentCache(c,ns,1001).get(key);
  assert.equal(updated.captured_at,persisted.captured_at);assert.equal(updated.checked_at,'2026-11-01T13:00:00.000Z');
  const failed=await runCollection({store:c,namespace:ns,sources:[source],runKey:'failed',transport:async()=>response({},503)});
  assert.equal(failed.state,'incomplete');assert.equal(failed.outcomes[0].state,'unavailable');
  const state=a.listSources(ns)[0];assert.equal(state.comparisonHead.runId,secondHead);
  assert.equal(state.latestAttempt.status,'unavailable');
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM collector_runs WHERE namespace=?').get(ns).n,3);
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM collector_attempts WHERE namespace=?').get(ns).n,4);
  const artifacts=a.db.prepare('SELECT payload FROM collector_cache WHERE namespace=?').all(ns);
  assert.ok(artifacts.every(row=>!row.payload.includes('Authored synthetic fixture only.')&&!row.payload.includes('author')));
});
test('global request budget covers four fixed sources and no transaction encloses transport',async t=>{
  const store=temporary(t).open();const labels=['vercel/eve','ollama/ollama','microsoft/playwright','vitejs/vite'];
  const sources=labels.map((label,i)=>createSource(label,1001+i));let calls=0;
  const watchedIdsBySource=Object.fromEntries(sources.map(s=>[s.sourceId,[1,2,3,4]]));
  const result=await runCollection({store,namespace:'test:budget',sources,runKey:'budget',watchedIdsBySource,transport:async request=>{
    calls++;assert.equal(store.db.isTransaction,false);
    const url=new URL(request.url);
    if(url.searchParams.get('page')==='1')return response([raw(1)],200,{link:'<https://api.github.com'+url.pathname+'?per_page=20&page=2>; rel="next"'});
    if(url.search)return response([raw(2)]);
    return response(raw(Number(url.pathname.split('/').at(-1))));
  }});
  assert.equal(result.state,'captured');assert.equal(calls,24);assert.equal(result.attempted,24);assert.equal(result.budget_remaining,0);
  assert.ok(result.outcomes.every(row=>row.attempted===6));
});
test('artifact insertion failure rolls back evidence, observation, head, attempts and cache together',async t=>{
  const temp=temporary(t);const store=temp.open();installCollectorTables(store);
  store.db.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON collector_attempts BEGIN SELECT RAISE(ABORT,'attempt_failure'); END;");
  const result=await runCollection({store,namespace:'test:rollback',sources:[source],runKey:'rollback',transport:async()=>response([raw()],200,{etag:'etag'})});
  assert.equal(result.state,'failed');assert.equal(result.outcomes[0].persistence,'not_committed');
  const independent=temp.open();
  for(const table of ['observations','evidence','collector_attempts','collector_cache','collector_runs'])assert.equal(independent.db.prepare('SELECT count(*) AS n FROM '+table+' WHERE namespace=?').get('test:rollback').n,0);
  assert.equal(independent.listSources('test:rollback')[0].comparisonHead,null);
});
test('returning stale worker cannot commit staged cache after replacement worker advances head',async t=>{
  const temp=temporary(t);const store=temp.open();const replacement=temp.open();const ns='test:fence';
  const result=await runCollection({store,namespace:ns,sources:[source],runKey:'old',transport:async()=>{
    replacement.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=? AND source_id=?').run(ns,1001);
    const lease=replacement.acquireLease(ns,1001,'replacement',120000);
    replacement.recordObservation({namespace:ns,sourceId:1001,lease,expectedHead:lease.expectedHead,
      evidence:[normalizeRelease(raw(),{namespace:ns,sourceId:1001})],status:'captured',coverage:{complete:true},runId:'replacement'});
    return response([raw()],200,{etag:'old-worker'});
  }});
  assert.equal(result.state,'failed');assert.equal(result.outcomes[0].error_code,'stale_lease');
  assert.equal(replacement.listSources(ns)[0].comparisonHead.runId,'replacement');
  assert.equal(replacement.db.prepare('SELECT count(*) AS n FROM collector_cache WHERE namespace=?').get(ns).n,0);
  assert.equal(replacement.db.prepare('SELECT count(*) AS n FROM collector_attempts WHERE namespace=?').get(ns).n,0);
});
test('reused run key refuses without replaying requests',async t=>{
  const store=temporary(t).open();let calls=0;const args={store,namespace:'test:key',sources:[source],runKey:'stable',transport:async()=>{calls++;return response([]);}};
  await runCollection(args);await assert.rejects(runCollection(args),/collection_run_key_already_exists/);assert.equal(calls,1);
});

