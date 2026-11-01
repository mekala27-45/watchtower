import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../packages/workflow/store.mjs';
import {normalizeRelease,makeObservation,makeBundle,baseline} from '../packages/domain/index.mjs';
const worker=fileURLToPath(new URL('../scripts/fault-worker.mjs',import.meta.url));
async function killAtHook(mode,path){
 const child=spawn(process.execPath,[worker,mode,path],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stderr='';
 child.stderr.on('data',x=>stderr+=x);
 const message=await new Promise((resolve,reject)=>{
  let out='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('hook_timeout '+stderr));},10000);
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('exit',code=>{if(!out.includes('\n')){clearTimeout(timer);reject(new Error('child_early_exit '+code+' '+stderr));}});
  child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(out.split('\n')[0]));}catch(e){reject(e);}}});
 });
 const terminated=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject)});
 child.kill('SIGKILL');
 return {message,termination:await terminated};
}
test('real collection process death rolls back evidence, observation and event across a fresh connection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'watchtower-process-')),path=join(dir,'state.sqlite');
 const initial=new Store(path);
 try{
 initial.registerSource('test:process',23,'authored/process');
 const lease=initial.acquireLease('test:process',23,'initial');
 initial.recordObservation({namespace:'test:process',sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[{itemId:1,tag:'committed'}],runId:'baseline'});
 initial.close();
 const result=await killAtHook('collection',path);assert.equal(result.message.hook,'after_evidence_before_commit');
 const independent=new Store(path);
 try{
  assert.equal(independent.getRun('test:process','uncommitted'),null);
  assert.equal(independent.db.prepare('SELECT count(*) AS n FROM evidence WHERE namespace=?').get('test:process').n,1);
  assert.equal(independent.db.prepare('SELECT count(*) AS n FROM events WHERE namespace=?').get('test:process').n,1);
  assert.equal(independent.listSources('test:process')[0].comparisonHead.runId,'baseline');
  independent.db.prepare('UPDATE leases SET expires_at=0 WHERE namespace=?').run('test:process');
  const recovery=independent.acquireLease('test:process',23,'recovered');
  const saved=independent.recordObservation({namespace:'test:process',sourceId:23,lease:recovery,expectedHead:recovery.expectedHead,status:'captured',coverage:{complete:true},evidence:[{itemId:2,tag:'recovered'}],runId:'recovered'});
  assert.equal(saved.comparisonHead,'recovered');
 }finally{independent.close();}
 }finally{try{initial.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('real process death after publication commit recovers the original receipt without a duplicate effect',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'watchtower-response-')),path=join(dir,'state.sqlite');
 const initial=new Store(path);
 try{
 initial.registerSource('test:publication',23,'authored/publication');
 const lease=initial.acquireLease('test:publication',23,'initial');
 const raw={id:1,tag_name:'v1',draft:false,prerelease:false,assets:[],body:'Authored.',created_at:'2026-10-01T00:00:00Z',published_at:'2026-10-01T00:00:00Z'};
 const before=normalizeRelease(raw,{namespace:'test:publication',sourceId:23}),after=normalizeRelease({...raw,tag_name:'v2'},{namespace:'test:publication',sourceId:23});
 initial.recordObservation({namespace:'test:publication',sourceId:23,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:[before],runId:'before'});
 const later=initial.acquireLease('test:publication',23,'later');
 initial.recordObservation({namespace:'test:publication',sourceId:23,lease:later,expectedHead:later.expectedHead,status:'captured',coverage:{complete:true},evidence:[after],runId:'after'});
 const bundle=makeBundle(makeObservation({namespace:'test:publication',sourceId:23,items:[before]}),makeObservation({namespace:'test:publication',sourceId:23,items:[after]}));
 const b=initial.prepareBriefing({namespace:'test:publication',findings:baseline(bundle).proposals,bundle,beforeRunId:'before',afterRunId:'after',evidenceIds:[before.id,after.id],coverage:{complete:true,scope:'authored'},method:'deterministic_baseline'});
 initial.approveBriefing('test:publication',b.digest,{reviewer:'synthetic_reviewer',scope:'test:publication'});initial.close();
 const result=await killAtHook('publication',path);assert.equal(result.message.hook,'after_publication_before_response');
 const independent=new Store(path);
 try{
  const retry=independent.publishBriefing('test:publication',b.digest,{operationKey:'lost-response'});
  assert.equal(retry.recovered,true);assert.equal(retry.receiptId,result.message.receipt.receiptId);
  assert.equal(independent.db.prepare('SELECT count(*) AS n FROM publications WHERE namespace=?').get('test:publication').n,1);
  assert.equal(independent.db.prepare("SELECT count(*) AS n FROM events WHERE namespace=? AND kind='publication_committed'").get('test:publication').n,1);
  assert.equal(independent.db.prepare('SELECT count(*) AS n FROM receipts WHERE namespace=?').get('test:publication').n,1);
 }finally{independent.close();}
 }finally{try{initial.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

