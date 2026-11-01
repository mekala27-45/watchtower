import { readFileSync,readdirSync,mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn,execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, digest } from '../packages/workflow/store.mjs';
import { normalizeRelease, makeObservation, makeBundle, baseline } from '../packages/domain/index.mjs';
import { loadFixtureBundle } from '../packages/domain/fixture-loader.mjs';
import { collectSource,createSource } from '../packages/collector/index.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),worker=join(root,'scripts/fault-worker.mjs');
const read=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
const planPath=join(root,'docs/fault-plan.json'),plan=read('docs/fault-plan.json');
const planDigest=createHash('sha256').update(readFileSync(planPath)).digest('hex');
const planCommit=execFileSync('git',['log','-1','--format=%H','--','docs/fault-plan.json'],{cwd:root,encoding:'utf8'}).trim();
if(!planCommit)throw new Error('fault_plan_must_be_committed_before_execution');
const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const implementationDigests=Object.fromEntries(['scripts/fault-matrix.mjs','scripts/fault-worker.mjs','packages/workflow/store.mjs','packages/domain/index.mjs','packages/domain/fixture-loader.mjs','packages/collector/index.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]));
const fixtures=readdirSync(join(root,'fixtures/heldout')).filter(x=>x.endsWith('.json')).sort().map(x=>read('fixtures/heldout/'+x));
assert.equal(fixtures.length,plan.plannedSequences);
const scratch=mkdtempSync(join(tmpdir(),'watchtower-matrix-')),rows=[];
const startedAt=new Date().toISOString();
const source=createSource('vercel/eve',1001),clock='2026-11-01T00:00:00Z';
const canary={id:99001,tag_name:'authored-boundary-canary',draft:false,prerelease:false,assets:[],body:'Authored fault canary.',created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z'};
const ok=body=>({status:200,headers:{'content-type':'application/json'},body});
async function killAtHook(mode,path,spec){
 const specPath=path+'.spec.json';writeFileSync(specPath,JSON.stringify(spec));
 const child=spawn(process.execPath,[worker,mode,path,specPath],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let err='';child.stderr.on('data',c=>err+=c);
 const message=await new Promise((resolve,reject)=>{
  let out='';let resolved=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('hook_timeout '+err));},10000);
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('exit',code=>{if(!resolved){clearTimeout(timer);reject(new Error('early_exit '+code+' '+err));}});
  child.stdout.on('data',c=>{out+=c;if(out.includes('\n')&&!resolved){resolved=true;clearTimeout(timer);try{resolve(JSON.parse(out.split('\n')[0]));}catch(e){reject(e)}}});
 });
 const end=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject)});
 child.kill('SIGKILL');await end;return message;
}
function commit(store,ns,items,runId,status='captured',coverage={complete:true}){
 const lease=store.acquireLease(ns,1001,'matrix-'+runId);
 return store.recordObservation({namespace:ns,sourceId:1001,lease,expectedHead:lease.expectedHead,status,coverage,evidence:items,runId});
}
function initial(store,ns,raw){store.registerSource(ns,1001,'vercel/eve');return commit(store,ns,[normalizeRelease(raw,{namespace:ns,sourceId:1001})],'baseline');}
function counts(store,ns){return Object.fromEntries(['evidence','observations','events','publications','receipts'].map(t=>[t,store.db.prepare('SELECT count(*) AS n FROM '+t+' WHERE namespace=?').get(ns).n]));}
async function execute(fixture,overlay){
 const ns='test:'+fixture.id.replaceAll('-','_')+'_'+overlay;
 const path=join(scratch,fixture.id+'-'+overlay+'.sqlite');
 let raw;
 for(const obs of fixture.observations){for(const candidate of obs?.raw_items??[]){try{normalizeRelease(candidate,{namespace:ns,sourceId:1001});raw=candidate;break;}catch{}}if(raw)break;}
 const usingCanary=!raw;raw??=canary;
 const store=new Store(path);
 try{
  const init=initial(store,ns,raw),before=counts(store,ns),preDigest=digest(before);
  if(['request_timeout','throttle_deferred','missing_cache_304','second_page_invalid','conflicting_duplicate'].includes(overlay)){
   let calls=0;
   const transport=async()=>{
    calls++;
    if(overlay==='request_timeout')throw Object.assign(new Error('injected timeout'),{name:'TimeoutError'});
    if(overlay==='throttle_deferred')return{status:429,headers:{'retry-after':'60'},body:null};
    if(overlay==='missing_cache_304')return{status:304,headers:{},body:null};
    if(calls===1)return{...ok([raw]),headers:{'content-type':'application/json',link:'<https://api.github.com/repos/vercel/eve/releases?per_page=20&page=2>; rel="next"'}};
    if(overlay==='second_page_invalid')return ok('malformed authored JSON');
    return ok([{...raw,tag_name:raw.tag_name+'-conflict'}]);
   };
   const result=await collectSource({source,namespace:ns,transport,cache:new Map(),now:clock});
   const expected={request_timeout:'unavailable',throttle_deferred:'deferred',missing_cache_304:'unavailable',second_page_invalid:'partial',conflicting_duplicate:'unstable'}[overlay];
   assert.equal(result.state,expected);assert.equal(result.coverage.procedure_complete,false);assert.ok(result.attempts.length>=1&&result.attempts.length<=2);
   if(overlay==='throttle_deferred')assert.ok(Date.parse(result.next_eligible_at)>Date.parse(clock));
   if(overlay==='missing_cache_304')assert.equal(result.attempts.length,2);
   commit(store,ns,result.items,'fault-result',result.state,{complete:false,reason:overlay,manifest:result.coverage});
   const other=new Store(path);try{assert.equal(other.listSources(ns)[0].comparisonHead.runId,init.runId);assert.equal(other.listSources(ns)[0].latestAttempt.status,expected);return{preDigest,postDigest:digest(counts(other,ns)),assertion:'unknown_attempt_and_preserved_baseline',transport:'injected_no_socket',attempts:result.attempts.length,usingCanary};}finally{other.close();}
  }
  if(overlay==='expired_replaced_lease'){
   const old=store.acquireLease(ns,1001,'old');store.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=?').run(ns);
   const replacement=commit(store,ns,[normalizeRelease({...raw,tag_name:raw.tag_name+'-replacement'},{namespace:ns,sourceId:1001})],'replacement');
   assert.throws(()=>store.recordObservation({namespace:ns,sourceId:1001,lease:old,expectedHead:old.expectedHead,status:'captured',coverage:{complete:true},evidence:[],runId:'old'}),e=>e.code==='stale_lease');
   const other=new Store(path);try{assert.equal(other.listSources(ns)[0].comparisonHead.runId,replacement.runId);return{preDigest,postDigest:digest(counts(other,ns)),assertion:'replacement_committed_old_worker_rejected',usingCanary};}finally{other.close();}
  }
  if(overlay==='process_death_pre_commit'){
   const future=normalizeRelease({...raw,tag_name:raw.tag_name+'-uncommitted'},{namespace:ns,sourceId:1001});
   const signal=await killAtHook('collection',path,{namespace:ns,sourceId:1001,evidence:[future]});
   assert.equal(signal.hook,'after_evidence_before_commit');
   const other=new Store(path);try{assert.deepEqual(counts(other,ns),before);assert.equal(other.getEvidence(ns,future.id),null);assert.equal(other.listSources(ns)[0].comparisonHead.runId,'baseline');other.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=?').run(ns);commit(other,ns,[future],'recovered');assert.ok(other.getEvidence(ns,future.id));return{preDigest,postDigest:digest(counts(other,ns)),assertion:'process_kill_rollback_then_fresh_connection_recovery',processBoundary:true,usingCanary};}finally{other.close();}
  }
  if(overlay==='process_death_post_commit'){
   const transition=fixture.truth.findIndex(x=>(x.findings?.length??0)>0)+1;
   const localFixture={...fixture,namespace:ns};
   const bundle=loadFixtureBundle(localFixture,{transition});
   const proposal=baseline(bundle);
   assert.ok(proposal.proposals.length);
   commit(store,ns,bundle.before.items,'fixture-before');
   commit(store,ns,bundle.after.items,'fixture-after',bundle.after.state,{complete:bundle.after.state==='captured'});
   const b=store.prepareBriefing({namespace:ns,method:'deterministic_baseline',findings:proposal.proposals,bundle,beforeRunId:'fixture-before',afterRunId:'fixture-after',evidenceIds:Object.keys(bundle.evidence),coverage:{complete:bundle.after.coverage.procedure_complete,warning:'Declared synthetic fixture coverage retained.',scope:bundle.after.scope}});
   store.approveBriefing(ns,b.digest,{reviewer:'synthetic_reviewer',scope:ns});
   const signal=await killAtHook('publication',path,{namespace:ns});assert.equal(signal.hook,'after_publication_before_response');
   const other=new Store(path);try{const recovered=other.publishBriefing(ns,b.digest,{operationKey:'lost-response'});assert.equal(recovered.receiptId,signal.receipt.receiptId);assert.equal(recovered.recovered,true);assert.equal(counts(other,ns).publications,1);assert.equal(counts(other,ns).receipts,1);return{preDigest,postDigest:digest(counts(other,ns)),assertion:'process_kill_committed_receipt_recovered_without_duplicate',processBoundary:true,receiptDigest:digest(recovered),usingCanary};}finally{other.close();}
  }
  throw new Error('unknown_overlay');
 }finally{store.close();}
}
for(const fixture of fixtures){
 for(const overlay of plan.overlays){
  const applicable=overlay!=='process_death_post_commit'||fixture.truth.some(x=>(x.findings?.length??0)>0);
  const row={fixtureId:fixture.id,overlay,applicable,backend:'sqlite_local_candidate',planDigest};
  if(!applicable){rows.push({...row,status:'not_applicable',reason:'Authored truth contains no eligible factual publication.'});continue;}
  try{rows.push({...row,status:'recovered',...await execute(fixture,overlay)});}
  catch(error){rows.push({...row,status:'failed',errorCode:error.code??error.message,stack:error.stack?.split('\n').slice(0,4)});}
 }
}
const count=status=>rows.filter(r=>r.status===status).length;
const report={schema:'fault-matrix-v1',planDigest,planCommit,sourceRevision,implementationDigests,startedAt,finishedAt:new Date().toISOString(),backend:'sqlite_local_candidate',transport:'injected_no_socket',planned:rows.length,applicable:rows.filter(r=>r.applicable).length,exercised:rows.filter(r=>r.applicable).length,recovered:count('recovered'),failed:count('failed'),notApplicable:count('not_applicable'),rows,limitations:plan.limitations};
mkdirSync(join(root,'reports/faults'),{recursive:true});writeFileSync(join(root,'reports/faults/matrix.json'),JSON.stringify(report,null,2)+'\n');
rmSync(scratch,{recursive:true,force:true});
console.log(JSON.stringify({...report,rows:undefined}));
if(report.failed)process.exitCode=1;

