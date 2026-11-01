import { Store } from '../packages/workflow/store.mjs';
import { writeSync,readFileSync } from 'node:fs';
const [mode,path,specPath]=process.argv.slice(2);
const spec=specPath?JSON.parse(readFileSync(specPath,'utf8')):{};
function stoppedHook(message){writeSync(1,JSON.stringify(message)+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);throw new Error('parent_did_not_terminate');}
if(mode==='collection'){
 const store=new Store(path,{testHooks:{afterEvidence(){stoppedHook({hook:'after_evidence_before_commit'});}}});
 const ns=spec.namespace??'test:process',sourceId=spec.sourceId??23;
 const lease=store.acquireLease(ns,sourceId,'child');
 store.recordObservation({namespace:ns,sourceId,lease,expectedHead:lease.expectedHead,status:'captured',coverage:{complete:true},evidence:spec.evidence??[{itemId:2,tag:'uncommitted'}],runId:'uncommitted'});
}else if(mode==='publication'){
 const store=new Store(path,{testHooks:{afterPublicationCommit(receipt){stoppedHook({hook:'after_publication_before_response',receipt});}}});
 const ns=spec.namespace??'test:publication';
 const briefing=store.listBriefings(ns)[0];
 store.publishBriefing(ns,briefing.digest,{operationKey:'lost-response'});
}else throw new Error('unknown_mode');

