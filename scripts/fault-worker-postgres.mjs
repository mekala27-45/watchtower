import {readFileSync,writeSync} from 'node:fs';
import {PostgresStore} from '../packages/workflow/postgres.mjs';

const [mode,specPath]=process.argv.slice(2),spec=JSON.parse(readFileSync(specPath,'utf8'));
if(!/^test:matrix_[a-f0-9]+_[a-zA-Z0-9_-]+$/.test(spec.namespace??''))throw Error('invalid_fault_namespace');
function stoppedHook(message){
 writeSync(1,JSON.stringify({...message,process_id:process.pid})+'\n');
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
 throw Error('parent_did_not_terminate');
}
let store;
try{
 const testHooks=mode==='collection'?{afterEvidence(){stoppedHook({hook:'after_evidence_before_commit'});}}:
  mode==='publication'?{afterPublicationCommit(receipt){stoppedHook({hook:'after_publication_before_response',receipt});}}:null;
 if(!testHooks)throw Error('unknown_mode');
 store=await PostgresStore.create({connectionString:process.env.WATCHTOWER_TEST_DATABASE_URL||process.env.DATABASE_URL,testHooks});
 if(mode==='collection'){
  const lease=await store.acquireLease(spec.namespace,spec.sourceId,'fault-child');
  await store.recordObservation({namespace:spec.namespace,sourceId:spec.sourceId,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:spec.evidence,runId:'uncommitted'});
 }else await store.publishBriefing(spec.namespace,spec.briefingDigest,{operationKey:'lost-response'});
}catch(error){writeSync(2,JSON.stringify({error_code:typeof error.code==='string'?error.code:'fault_worker_failed'})+'\n');process.exitCode=1;}
finally{await store?.close();}
