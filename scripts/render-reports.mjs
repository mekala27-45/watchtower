import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {metric,sealManifest,renderTable,DISCLAIMER} from '../packages/reports/index.mjs';
import {validateReportInputs} from '../packages/reports/input.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const baseline=read('reports/baseline/full.json'),subset=read('reports/baseline/model-subset.json'),model=read('reports/model/current.json');
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const plan=read('docs/evaluation-plan.json'),provenance=read('reports/model/provenance.json');
if(!/^unavailable-[a-zA-Z0-9-]+$/.test(provenance.run_id||''))throw Error('unsafe_model_run_id');
const admitted=validateReportInputs({baseline,subset,model,plan,modelArchive:read('reports/model/runs/'+provenance.run_id+'.json')},revision);
const metrics=[];
const add=(id,value,unit,method,dataset,evidence,other={})=>metrics.push(metric({id,value,unit,method,dataset,evidence,window:'frozen authored temporal corpus',plan_digest:baseline.plan_digest,code_revision:revision,...other}));
for(const [label,report,path] of [['full',baseline,'reports/baseline/full.json'],['subset',subset,'reports/baseline/model-subset.json']]){
 const s=report.summary;
 for(const name of ['sequences','transitions','expected','emitted','matched','duplicates','unsupported'])add('baseline.'+label+'.'+name,s[name],name==='sequences'?'sequences':name==='transitions'?'transitions':'findings','deterministic_baseline',report.dataset,path);
 for(const [name,num,den] of [['precision',s.matched,s.emitted],['recall',s.matched,s.expected],['exact_sequences',s.exact_sequences,s.sequences],['no_op',s.no_op.correct,s.no_op.total],['unknown',s.unknown.correct,s.unknown.total]]){
  add('baseline.'+label+'.'+name,den?num/den:null,'ratio','deterministic_baseline',report.dataset,path,{numerator:num,denominator:den,state:den?'available':'not_applicable'});
 }
}
for(const name of ['planned','attempted','completed','unexecuted'])add('model.'+name,model[name],'sequences','local_agent',model.dataset,'reports/model/current.json',{category:'execution'});
for(const name of ['precision','recall','supported_proposals'])add('model.'+name,null,name==='supported_proposals'?'findings':'ratio','local_agent',model.dataset,'reports/model/current.json',{state:'unavailable'});
const manifest=sealManifest({schema_version:'watchtower-report-v1',namespace:'reports',mode:'separate_methods',code_revision:revision,plan_digest:baseline.plan_digest,generated_at:new Date().toISOString(),metrics,baseline,baseline_subset:subset,model,runs:{deterministic_baseline:{status:admitted.baseline_status,rows:baseline.summary.sequences,execution_receipt:admitted.baseline_execution},local_agent:{status:admitted.model_status,rows:model.planned,attempted:model.attempted,execution_receipt:null}},limits:{backend:'sqlite_local_candidate',public_api:null,public_site:null,dispatch:null,fonts:'not_installed',browser:'not_executed'}});
mkdirSync('reports',{recursive:true});writeFileSync('reports/current.json',JSON.stringify(manifest,null,2)+'\n');
const checklist=existsSync('reports/checklist.json')?read('reports/checklist.json'):[];
const checklistText=checklist.map((r,i)=>(i+1)+'. **'+r.status+'** '+r.item+' '+r.evidence).join('\n\n');
const result='# Watchtower results\n\nLocal candidate. The required hosted and actual-model core is incomplete.\n\n'+DISCLAIMER+'\n\n## Deterministic baseline\n\n'+renderTable(manifest,'deterministic_baseline')+'\n\n## Actual local model\n\n'+renderTable(manifest,'local_agent')+'\n\nActual inference did not run. Contract-test handler executions are not model executions. No supported actual-model example exists. The registered cases remain visible with unexecuted outcomes.\n\n## Recovery and provenance\n\nSee reports/faults for local stored-state assertions and process-death evidence. These checks do not establish hosted Postgres behavior. See reports/verification for local suite, scan and rederivation results. The baseline source revision is preserved in its underlying report; this report revision identifies the renderer inputs.\n\n## Section 20 checklist\n\n'+checklistText+'\n';
writeFileSync('RESULTS.md',result);
writeFileSync('README.md','# Watchtower\n\nFailed collection must not look like a quiet source. Watchtower captures bounded release metadata, checks typed differences, freezes evidence for review and recovers an internal publication receipt after a lost response.\n\nThis is a local candidate with a native JavaScript API, proof-sheet UI and SQLite persistence. The required eve inference, Neon Postgres runtime, Vercel API and public Pages release remain incomplete. Production startup refuses the local adapter.\n\n'+DISCLAIMER+'\n\nRun the deterministic evaluation with npm run evaluate. Start the local interface with npm start or deploy/Run-Local.ps1. Run npm test for the local checks. Run npm run eval:model for the separate actual-model availability gate; it currently exits unsuccessfully and preserves all registered cases.\n\nOpen RESULTS.md for code-rendered baseline and actual-model tables. Read docs/operator.md for blocked target checks and concrete commands. No public API URL, site URL or successful workflow dispatch is available.\n\n## Completion\n\n'+checklistText+'\n');
console.log(JSON.stringify({status:'rendered',manifest_digest:manifest.digest,baseline_sequences:baseline.summary.sequences,model_attempted:model.attempted}));
