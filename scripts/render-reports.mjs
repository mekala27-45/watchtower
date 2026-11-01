import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {metric,sealManifest,renderTable,renderNumericalSentence,DISCLAIMER} from '../packages/reports/index.mjs';
import {validateReportInputs} from '../packages/reports/input.mjs';
import {validateArchivedSourceRevision} from './report-source.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const baseline=read('reports/baseline/full.json'),subset=read('reports/baseline/model-subset.json'),model=read('reports/model/current.json');
const archived=process.argv.includes('--archived');
const requestedRevision=process.argv.find(arg=>arg.startsWith('--source-revision='))?.slice('--source-revision='.length);
const revision=requestedRevision??(archived?read('reports/current.json').code_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
const plan=read('docs/evaluation-plan.json'),provenance=read('reports/model/provenance.json');
if(archived||requestedRevision)validateArchivedSourceRevision(revision,{model,provenance,plan});
if(!/^(?:unavailable|actual)-[a-zA-Z0-9-]+$/.test(provenance.run_id||''))throw Error('unsafe_model_run_id');
let archive,fixtures;
if(provenance.run_id.startsWith('actual-')){
 const directory='reports/model/runs/'+provenance.run_id;
 archive={ledger:read(directory+'/ledger.json'),provenance:read(directory+'/provenance.json'),probe:read(directory+'/probe.json')};
 fixtures=['development','heldout'].flatMap(split=>readdirSync('fixtures/'+split).filter(name=>name.endsWith('.json')).map(name=>read('fixtures/'+split+'/'+name)));
}else archive=read('reports/model/runs/'+provenance.run_id+'.json');
if(JSON.stringify(archive.provenance)!==JSON.stringify(provenance))throw Error('current_model_provenance_mismatch');
const admitted=validateReportInputs({baseline,subset,model,plan,modelArchive:archive,fixtures},revision);
const metrics=[];
const add=(id,value,unit,method,dataset,evidence,other={})=>metrics.push(metric({id,value,unit,method,dataset,evidence,window:'frozen authored temporal corpus',plan_digest:baseline.plan_digest,code_revision:revision,...other}));
for(const [label,report,path] of [['full',baseline,'reports/baseline/full.json'],['subset',subset,'reports/baseline/model-subset.json']]){
 const s=report.summary;
 for(const name of ['sequences','transitions','expected','emitted','matched','duplicates','unsupported'])add('baseline.'+label+'.'+name,s[name],name==='sequences'?'sequences':name==='transitions'?'transitions':'findings','deterministic_baseline',report.dataset,path);
 for(const [name,num,den] of [['precision',s.matched,s.emitted],['recall',s.matched,s.expected],['exact_sequences',s.exact_sequences,s.sequences],['no_op',s.no_op.correct,s.no_op.total],['unknown',s.unknown.correct,s.unknown.total],['baseline_creation',s.baseline.correct,s.baseline.total]]){
  add('baseline.'+label+'.'+name,den?num/den:null,'ratio','deterministic_baseline',report.dataset,path,{numerator:num,denominator:den,state:den?'available':'not_applicable'});
 }
}
const addModel=(id,value,unit,other={})=>add('model.'+id,value,unit,'local_agent',model.dataset,'reports/model/current.json',other);
for(const name of ['planned','attempted','completed','unexecuted'])addModel(name,model[name],'sequences',{category:'execution'});
if(admitted.model_coverage){
 addModel('failed',model.failed,'sequences',{category:'execution'});
 for(const name of ['transitions','attempted_transitions','model_requests','provider_tool_calls','handler_executions'])addModel(name,admitted.model_coverage[name],name.includes('transition')?'transitions':'events',{category:'execution'});
 for(const name of ['expected','emitted','matched','missed','duplicates','unsupported','unsupported_publications'])addModel(name,model.attempted?admitted.model_summary[name]:null,'findings',{state:model.attempted?'available':'unavailable'});
 for(const category of ['no_op','unknown','baseline']){
  const {correct,total}=admitted.model_coverage[category];
  addModel(category,model.attempted&&total?correct/total:null,'ratio',{state:!model.attempted?'unavailable':total?'available':'not_applicable',numerator:model.attempted?correct:null,denominator:model.attempted?total:null});
 }
}
for(const name of ['precision','recall','supported_proposals']){
 const m=admitted.model_metrics[name];
 addModel(name,m.value,name==='supported_proposals'?'findings':'ratio',{state:m.state,numerator:m.numerator??null,denominator:m.denominator??null});
}
const delivery=existsSync('reports/verification/delivery.json')?read('reports/verification/delivery.json'):{};
const publicUrl=value=>typeof value==='string'&&/^https:\/\/[a-zA-Z0-9.-]+(?:\/[^\s]*)?$/.test(value)?value:null;
const apiUrl=delivery.api?.verified?publicUrl(delivery.api.url):null,siteUrl=delivery.site?.verified?publicUrl(delivery.site.url):null;
const checklist=existsSync('reports/checklist.json')?read('reports/checklist.json'):[];
if(checklist.length&&checklist.some(r=>!['done','not done'].includes(r.status)||typeof r.evidence!=='string'||!r.evidence))throw Error('invalid_completion_checklist');
const limits={backend:delivery.backend??'unverified',public_api:apiUrl,public_site:siteUrl,dispatch:delivery.dispatch?.verified?delivery.dispatch:null,fonts:delivery.fonts??'unverified',browser:delivery.browser??'not_executed',delivery_evidence:'reports/verification/delivery.json'};
const manifest=sealManifest({schema_version:'watchtower-report-v1',namespace:'reports',mode:'separate_methods',code_revision:revision,plan_digest:baseline.plan_digest,generated_at:new Date().toISOString(),metrics,baseline,baseline_subset:subset,model,checklist,completion:checklist,
 runs:{deterministic_baseline:{status:admitted.baseline_status,rows:baseline.summary.sequences,execution_receipt:admitted.baseline_execution},local_agent:{status:admitted.model_status,rows:model.planned,attempted:model.attempted,execution_receipt:admitted.model_execution}},limits});
mkdirSync('reports',{recursive:true});writeFileSync('reports/current.json',JSON.stringify(manifest,null,2)+'\n');
const checklistText=checklist.map((r,i)=>(i+1)+'. **'+r.status+'** '+r.item+' '+r.evidence).join('\n\n');
const completed=checklist.length===18&&checklist.every(r=>r.status==='done');
const status=completed?'The required implementation and release checks are complete.':'Implementation and verification results are recorded below. Any unfinished requirement remains marked not done in the completion checklist.';
const modelText=model.attempted?renderNumericalSentence('Actual inference attempted {model.attempted} from the registered {model.planned}. Supported proposals: {model.supported_proposals}.',['model.attempted','model.planned','model.supported_proposals'],manifest)+' '+
 (model.demonstration_passed?'The registered model demonstration criteria passed.':'The registered model demonstration criteria did not pass.')+' Failures and unexecuted cases remain in the declared denominator. Previewed findings remain unapproved. No preview is represented as a publication.':
 'Actual inference did not run. Contract-test handler executions supply no model execution or quality evidence. The registered cases remain visible with unexecuted outcomes.';
const deliveryText=[apiUrl?'Verified API: '+apiUrl+'.':'A public API is not verified.',siteUrl?'Verified Pages site: '+siteUrl+'.':'A public Pages site is not verified.',delivery.dispatch?.verified?'Actual collection dispatch evidence: '+(delivery.dispatch.run_url??'reports/verification/delivery.json')+'.':'Actual Actions dispatch is not verified.',delivery.release?.verified?'Public release evidence: '+(delivery.release.url??'reports/verification/delivery.json')+'.':'A public release is not verified.'].join(' ');
const gifPath=typeof delivery.demo_gif==='string'?delivery.demo_gif:delivery.demo_gif?.path;
const gif=typeof gifPath==='string'&&/^reports\/browser\/[A-Za-z0-9_-]+\.gif$/.test(gifPath)&&existsSync(gifPath)?'\n\n![Recorded Watchtower review and receipt demonstration]('+gifPath+')\n\nRecorded browser demonstration. This image is not a live service status.':'';
const failedRow=model.rows.find(row=>row.status==='failed');
const failedTransition=failedRow?.transitions?.find(t=>t.status!=='completed');
const detailCode=failedTransition?.error?.message;
const failureCode=typeof detailCode==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(detailCode)?detailCode:String(failedTransition?.error?.code??failedTransition?.reply_error??failedTransition?.status??'runtime_failure').replace(/[^A-Za-z0-9_-]/g,'_');
const failedCase=failedRow&&/^[A-Za-z0-9_-]+$/.test(failedRow.fixture_id)?'\n\nRecorded failed case: ['+failedRow.fixture_id+'](reports/model/runs/'+provenance.run_id+'/'+failedRow.fixture_id+'.json). Its recorded failure code is '+failureCode+'. This case remains in the declared denominator.':'';
const scopeText='\n\n## Claims this evidence can support\n\n- Changes to captured release metadata within the declared observation window.\n- Behavior on the named authored synthetic scenarios and recorded failure cases.\n- Recovery of a committed internal publication receipt using the same operation key.\n- What the evaluated local model and observed tool handlers did under the frozen configuration.\n\n## Claims this evidence cannot support\n\n- Complete source history or deletion inferred from missing items.\n- Security assessments, compatibility conclusions or upgrade recommendations.\n- General model accuracy outside the frozen authored subset.\n- Exactly once effects across arbitrary external services.\n- Exact schedule timing or an unverified automatic collection run.';
const result='# Watchtower results\n\n'+status+'\n\n'+DISCLAIMER+'\n\n## Deterministic baseline\n\n'+renderTable(manifest,'deterministic_baseline')+'\n\n## Actual local model\n\n'+renderTable(manifest,'local_agent')+'\n\n'+modelText+'\n\n## Deployment and delivery\n\n'+deliveryText+'\n\n## Recovery and provenance\n\nSee reports/faults for stored-state assertions and process-death evidence. See reports/verification for database, browser, suite, scan and rederivation evidence. Read each evidence backend label before interpreting a local recovery check as a hosted result. Baseline and actual model inputs must match the frozen evaluation plan and the source revision admitted by the report gate.\n\n## Section 20 checklist\n\n'+checklistText+'\n';
writeFileSync('RESULTS.md',result+failedCase+scopeText+'\n');
writeFileSync('README.md','# Watchtower\n\nFailed collection must not look like a quiet source. Watchtower captures bounded release metadata, checks typed differences, freezes evidence for review and recovers an internal publication receipt after a lost response.\n\n'+status+'\n\n'+DISCLAIMER+'\n\nRun the deterministic evaluation with npm run evaluate. Start the interface with npm start. Use the direct Neon Postgres connection for durable deployment, with local SQLite available for isolated development. Run npm test for verification and npm run eval:model for the separate actual local model lane. Read docs/operator.md before a collection or hosted run.\n\nOpen RESULTS.md for code-rendered baseline and actual-model tables. '+modelText+failedCase+'\n\n'+deliveryText+gif+scopeText+'\n\n## Completion\n\n'+checklistText+'\n');
console.log(JSON.stringify({status:'rendered',manifest_digest:manifest.digest,baseline_sequences:baseline.summary.sequences,model_attempted:model.attempted,model_status:admitted.model_status}));
