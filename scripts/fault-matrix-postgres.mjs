import {readFileSync,readdirSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {PostgresStore} from '../packages/workflow/postgres.mjs';
import {normalizeRelease,baseline,digest} from '../packages/domain/index.mjs';
import {loadFixtureBundle} from '../packages/domain/fixture-loader.mjs';
import {collectSource,createSource} from '../packages/collector/index.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))),worker=join(root,'scripts/fault-worker-postgres.mjs');
const read=path=>JSON.parse(readFileSync(join(root,path),'utf8'));
const planPath='docs/fault-plan-postgres.json',plan=read(planPath),planDigest=createHash('sha256').update(readFileSync(join(root,planPath))).digest('hex');
const planCommit=execFileSync('git',['log','-1','--format=%H','--',planPath],{cwd:root,encoding:'utf8'}).trim();
if(!planCommit)throw Error('postgres_fault_plan_must_be_committed_before_execution');
const registeredPlan=execFileSync('git',['show',planCommit+':'+planPath],{cwd:root});
if(createHash('sha256').update(registeredPlan).digest('hex')!==planDigest)throw Error('postgres_fault_plan_changed_since_registration');
const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const implementationDigests=Object.fromEntries(['scripts/fault-matrix-postgres.mjs','scripts/fault-worker-postgres.mjs','packages/workflow/postgres.mjs','packages/domain/index.mjs','packages/domain/fixture-loader.mjs','packages/collector/index.mjs'].map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]));
const fixtures=readdirSync(join(root,'fixtures/heldout')).filter(name=>name.endsWith('.json')).sort().map(name=>read('fixtures/heldout/'+name));
assert.equal(fixtures.length,plan.plannedSequences);
const runId='postgres-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'),prefix='test:matrix_'+randomBytes(8).toString('hex')+'_';
const scratch=join(root,'state/fault-matrix-specs',runId);mkdirSync(scratch,{recursive:true});
const startedAt=new Date().toISOString(),rows=[],source=createSource('vercel/eve',1001),clock='2026-11-01T00:00:00Z';
const connectionString=process.env.WATCHTOWER_TEST_DATABASE_URL||process.env.DATABASE_URL;
if(!connectionString)throw Error('database_url_required');
const canary={id:99001,tag_name:'authored-boundary-canary',draft:false,prerelease:false,assets:[],body:'Authored fault canary.',created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z'};
const ok=body=>({status:200,headers:{'content-type':'application/json'},body});
const tables={evidence:'evidence_revisions',observations:'observations',memberships:'observation_evidence',runs:'collection_runs',events:'workflow_events',publications:'publications',receipts:'publication_receipts',idempotency:'idempotency_records'};
async function snapshot(store,ns){
 const selects=Object.entries(tables).map(([name,table])=>`(SELECT count(*)::integer FROM watchtower.${table} WHERE namespace=$1) AS ${name}`);
 const result=(await store.db.query('SELECT '+selects.join(',')+`,(SELECT comparison_head_id FROM watchtower.source_heads WHERE namespace=$1 AND source_id=1001) AS comparison_head,(SELECT latest_attempt_id FROM watchtower.source_heads WHERE namespace=$1 AND source_id=1001) AS latest_attempt,(SELECT state FROM watchtower.observations WHERE namespace=$1 AND id=(SELECT latest_attempt_id FROM watchtower.source_heads WHERE namespace=$1 AND source_id=1001)) AS latest_state,(SELECT count(*)::integer FROM watchtower.workflow_events WHERE namespace=$1 AND event_kind='publication_committed') AS publication_events`,[ns])).rows[0];
 return result;
}
async function commit(store,ns,items,runId,status='captured',coverage={complete:true},scope='bounded-v1'){
 const lease=await store.acquireLease(ns,1001,'matrix-'+runId);
 return store.recordObservation({namespace:ns,sourceId:1001,lease,expectedHead:lease.expectedHead,status,coverage,evidence:items,runId,scope});
}
async function killAtHook(mode,spec){
 const specPath=join(scratch,spec.namespace.slice(prefix.length)+'.json');writeFileSync(specPath,JSON.stringify(spec));
 const child=spawn(process.execPath,[worker,mode,specPath],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,WATCHTOWER_TEST_DATABASE_URL:connectionString},windowsHide:true});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=(chunk.toString().slice(0,1000));});
 const terminated=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
 try{
  const signal=await new Promise((resolve,reject)=>{
   let output='',settled=false;
   const timer=setTimeout(()=>{if(!settled){settled=true;child.kill('SIGKILL');reject(Error('fault_hook_timeout'));}},45000);
   child.once('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
   child.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('fault_worker_early_exit'));}});
   child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')&&!settled){settled=true;clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]));}catch{reject(Error('fault_worker_invalid_signal'));}}});
  });
  const killRequested=child.kill('SIGKILL');const termination=await terminated;
  assert.equal(killRequested,true,'real child termination requested');
  return {...signal,kill_requested:killRequested,termination};
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await terminated.catch(()=>{});unlinkSync(specPath);}
}
async function execute(fixture,overlay,store,independent,connectionProof){
 const ns=prefix+fixture.id.replaceAll('-','_')+'_'+overlay;
 let raw;for(const observation of fixture.observations){for(const candidate of observation?.raw_items??[]){try{normalizeRelease(candidate,{namespace:ns,sourceId:1001});raw=candidate;break;}catch{}}if(raw)break;}
 const usingCanary=!raw;raw??=canary;
 await store.registerSource(ns,1001,'authored/fault-matrix');
 const init=await commit(store,ns,[normalizeRelease(raw,{namespace:ns,sourceId:1001})],'baseline'),before=await snapshot(independent,ns);
 const common={namespace:ns,connectionProof,preState:before,preDigest:digest(before),usingCanary};
 if(['request_timeout','throttle_deferred','missing_cache_304','second_page_invalid','conflicting_duplicate'].includes(overlay)){
  let calls=0;
  const transport=async()=>{calls++;if(overlay==='request_timeout')throw Object.assign(Error('injected timeout'),{name:'TimeoutError'});
   if(overlay==='throttle_deferred')return {status:429,headers:{'retry-after':'60'},body:null};
   if(overlay==='missing_cache_304')return {status:304,headers:{},body:null};
   if(calls===1)return {...ok([raw]),headers:{'content-type':'application/json',link:'<https://api.github.com/repos/vercel/eve/releases?per_page=20&page=2>; rel="next"'}};
   if(overlay==='second_page_invalid')return ok('malformed authored JSON');return ok([{...raw,tag_name:raw.tag_name+'-conflict'}]);};
  const result=await collectSource({source,namespace:ns,transport,cache:new Map(),now:clock});
  const expected={request_timeout:'unavailable',throttle_deferred:'deferred',missing_cache_304:'unavailable',second_page_invalid:'partial',conflicting_duplicate:'unstable'}[overlay];
  assert.equal(result.state,expected);assert.equal(result.coverage.procedure_complete,false);assert.ok(result.attempts.length>=1&&result.attempts.length<=2);
  if(overlay==='throttle_deferred')assert.ok(Date.parse(result.next_eligible_at)>Date.parse(clock));
  if(overlay==='missing_cache_304')assert.equal(result.attempts.length,2);
  await commit(store,ns,result.items,'fault-result',result.state,{complete:false,reason:overlay,manifest:result.coverage});
  const after=await snapshot(independent,ns);assert.equal(after.comparison_head,init.runId);assert.equal(after.latest_attempt,'fault-result');assert.equal(after.latest_state,expected);assert.equal(after.publications,0);assert.equal(after.receipts,0);
  return {...common,postState:after,postDigest:digest(after),assertion:'unknown_attempt_and_preserved_baseline',transport:'injected_no_socket',attempts:result.attempts.length};
 }
 if(overlay==='expired_replaced_lease'){
  const old=await store.acquireLease(ns,1001,'old');await store.db.query('UPDATE watchtower.source_leases SET expires_at=to_timestamp(0) WHERE namespace=$1',[ns]);
  const replacement=await commit(store,ns,[normalizeRelease({...raw,tag_name:raw.tag_name+'-replacement'},{namespace:ns,sourceId:1001})],'replacement');
  await assert.rejects(store.recordObservation({namespace:ns,sourceId:1001,lease:old,expectedHead:old.expectedHead,status:'captured',coverage:{complete:true},evidence:[],runId:'old'}),error=>error.code==='stale_lease');
  const after=await snapshot(independent,ns);assert.equal(after.comparison_head,replacement.runId);assert.equal(await independent.getRun(ns,'old'),null);
  return {...common,postState:after,postDigest:digest(after),assertion:'replacement_committed_old_worker_rejected'};
 }
 if(overlay==='process_death_pre_commit'){
  const future=normalizeRelease({...raw,tag_name:raw.tag_name+'-uncommitted'},{namespace:ns,sourceId:1001});
  const signal=await killAtHook('collection',{namespace:ns,sourceId:1001,evidence:[future]});assert.equal(signal.hook,'after_evidence_before_commit');
  const rollback=await snapshot(independent,ns);assert.deepEqual(rollback,before);assert.equal(await independent.getEvidence(ns,future.id),null);assert.equal(await independent.getRun(ns,'uncommitted'),null);
  await independent.db.query('UPDATE watchtower.source_leases SET expires_at=to_timestamp(0) WHERE namespace=$1',[ns]);
  await commit(independent,ns,[future],'recovered');const after=await snapshot(store,ns);assert.equal(after.comparison_head,'recovered');assert.ok(await store.getEvidence(ns,future.id));
  return {...common,rollbackState:rollback,postState:after,postDigest:digest(after),assertion:'process_kill_rollback_then_independent_connection_recovery',processBoundary:true,process:signal};
 }
 if(overlay==='process_death_post_commit'){
  const transition=fixture.truth.findIndex(t=>(t.findings?.length??0)>0)+1,bundle=loadFixtureBundle({...fixture,namespace:ns},{transition}),proposal=baseline(bundle);assert.ok(proposal.proposals.length);
  await commit(store,ns,bundle.before.items,'fixture-before','captured',{complete:true},bundle.before.scope);
  await commit(store,ns,bundle.after.items,'fixture-after',bundle.after.state,{complete:bundle.after.state==='captured'},bundle.after.scope);
  const briefing=await store.prepareBriefing({namespace:ns,method:'deterministic_baseline',findings:proposal.proposals,bundle,beforeRunId:'fixture-before',afterRunId:'fixture-after',evidenceIds:Object.keys(bundle.evidence),coverage:{complete:bundle.after.coverage.procedure_complete,warning:'Declared synthetic fixture coverage retained.',scope:bundle.after.scope}});
  await store.approveBriefing(ns,briefing.digest,{reviewer:'synthetic_reviewer',scope:ns});
  const signal=await killAtHook('publication',{namespace:ns,briefingDigest:briefing.digest});assert.equal(signal.hook,'after_publication_before_response');
  const recovered=await independent.publishBriefing(ns,briefing.digest,{operationKey:'lost-response'});assert.equal(recovered.receiptId,signal.receipt.receiptId);assert.equal(recovered.recovered,true);
  const after=await snapshot(independent,ns);for(const key of ['publications','receipts','idempotency','publication_events'])assert.equal(after[key],1,key);
  return {...common,postState:after,postDigest:digest(after),assertion:'process_kill_committed_receipt_recovered_without_duplicate',processBoundary:true,process:signal,receiptDigest:digest(recovered)};
 }
 throw Error('unknown_overlay');
}
const cases=fixtures.flatMap(fixture=>plan.overlays.map(overlay=>({fixture,overlay})));let next=0,finished=0;
async function lane(){
 const store=await PostgresStore.create({connectionString}),independent=await PostgresStore.create({connectionString});
 try{
  const writer=(await store.db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,reader=(await independent.db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  assert.notEqual(writer,reader);const connectionProof={writer_backend_pid:writer,independent_backend_pid:reader,distinct:true};
  for(;;){const index=next++;if(index>=cases.length)break;const {fixture,overlay}=cases[index],applicable=overlay!=='process_death_post_commit'||fixture.truth.some(t=>(t.findings?.length??0)>0);
   const row={fixtureId:fixture.id,overlay,applicable,backend:'postgres',planDigest};
   if(!applicable)rows[index]={...row,status:'not_applicable',reason:'Authored truth contains no eligible factual publication.'};
   else try{rows[index]={...row,status:'recovered',...await execute(fixture,overlay,store,independent,connectionProof)};}
   catch(error){rows[index]={...row,status:'failed',namespace:prefix+fixture.id.replaceAll('-','_')+'_'+overlay,errorCode:typeof error.code==='string'?error.code:'assertion_or_runtime_failure',message:String(error.message??'failure').replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted]').slice(0,800)};}
   finished++;if(finished%24===0)console.log(JSON.stringify({progress:finished,planned:cases.length,failed:rows.filter(r=>r?.status==='failed').length}));
  }
 }finally{await store.close();await independent.close();}
}
let fatal=null;
const laneResults=await Promise.allSettled(Array.from({length:Math.min(4,plan.maxConcurrentCases)},lane));
for(const result of laneResults)if(result.status==='rejected')fatal=typeof result.reason?.code==='string'?result.reason.code:'matrix_runtime_failure';
for(let i=0;i<cases.length;i++)if(!rows[i]){const {fixture,overlay}=cases[i];rows[i]={fixtureId:fixture.id,overlay,applicable:overlay!=='process_death_post_commit'||fixture.truth.some(t=>(t.findings?.length??0)>0),backend:'postgres',planDigest,status:'unexecuted',reason:fatal??'lane_incomplete'};}
const count=status=>rows.filter(r=>r.status===status).length;
const report={schema:'fault-matrix-postgres-v1',runId,namespacePrefix:prefix,planDigest,planCommit,sourceRevision,implementationDigests,startedAt,finishedAt:new Date().toISOString(),backend:'postgres',database_transport:'direct_tls_verified',transport:'injected_no_socket',planned:rows.length,applicable:rows.filter(r=>r.applicable).length,exercised:rows.filter(r=>r.applicable&&r.status!=='unexecuted').length,recovered:count('recovered'),failed:count('failed'),unexecuted:count('unexecuted'),notApplicable:count('not_applicable'),real_process_terminations:rows.filter(r=>r.processBoundary&&r.process.kill_requested).length,rows,limitations:plan.limitations,fatal};
mkdirSync(join(root,'reports/faults/postgres-runs'),{recursive:true});writeFileSync(join(root,'reports/faults/postgres-runs',runId+'.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(root,'reports/faults/postgres-matrix.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,rows:undefined}));if(report.failed||report.unexecuted||report.recovered!==report.applicable)process.exitCode=1;
