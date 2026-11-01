import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonical,validateManifest} from '../packages/reports/index.mjs';
import {validateReportInputs} from '../packages/reports/input.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8'));
const manifest=read('reports/current.json'),revision=manifest.code_revision;
if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('invalid_archived_source_revision');
validateManifest(manifest,revision);
const sourcePath=path=>/^(?:agent\/|packages\/|fixtures\/|apps\/|db\/|config\/|scripts\/|tests\/|package(?:-lock)?\.json$|(?:tsconfig|vite\.config)[^/]*$|docs\/(?:evaluation-plan|fault-plan|model-config|model-adapter-adjustment)[^/]*$)/.test(path);
if(process.argv.includes('--archived')){
 execFileSync('git',['merge-base','--is-ancestor',revision,'HEAD'],{stdio:'pipe'});
 const changed=execFileSync('git',['diff','--name-only',revision,'--'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 if([...changed,...untracked].some(sourcePath))throw Error('archived_source_changed');
}else if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==revision)throw Error('stale_input_revision');
const baseline=read('reports/baseline/full.json'),subset=read('reports/baseline/model-subset.json'),model=read('reports/model/current.json'),plan=read('docs/evaluation-plan.json'),provenance=read('reports/model/provenance.json');
if(!/^actual-[a-zA-Z0-9-]+$/.test(provenance.run_id??''))throw Error('actual_model_archive_required');
const directory='reports/model/runs/'+provenance.run_id;
const modelArchive={ledger:read(directory+'/ledger.json'),provenance:read(directory+'/provenance.json'),probe:read(directory+'/probe.json')};
if(canonical(provenance)!==canonical(modelArchive.provenance))throw Error('current_model_provenance_mismatch');
const fixtures=['development','heldout'].flatMap(split=>readdirSync('fixtures/'+split).filter(name=>name.endsWith('.json')).map(name=>read('fixtures/'+split+'/'+name)));
const admitted=validateReportInputs({baseline,subset,model,plan,modelArchive,fixtures},revision);
if(canonical(manifest.baseline)!==canonical(baseline)||canonical(manifest.baseline_subset)!==canonical(subset)||canonical(manifest.model)!==canonical(model))throw Error('manifest_input_mismatch');
if(model.attempted!==24||!model.cpu_placement_valid||admitted.model_status!=='executed')throw Error('actual_model_execution_incomplete');
console.log(JSON.stringify({status:'passed',mode:'archived_evidence_validation',inference_executed_in_this_job:false,source_revision:revision,plan_digest:plan.plan_digest,model_run_id:model.run_id,attempted:model.attempted,completed:model.completed,failed:model.failed,demonstration_passed:model.demonstration_passed}));
