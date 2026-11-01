import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest} from '../packages/reports/index.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const calculationInput=path=>/^(?:agent\/|packages\/(?:domain|reports)\/|fixtures\/|config\/|scripts\/(?:evaluate|generate-fixtures)\.mjs$|package(?:-lock)?\.json$|docs\/(?:evaluation-plan|fault-plan|model-config|model-freeze|model-adapter-adjustment)[^/]*$)/.test(path);

// Verification-only test, checker, UI and operator-document changes do not relabel
// an earlier inference run. Its calculation inputs and original frozen bytes must match.
export function validateArchivedSourceRevision(revision,{model,provenance,plan}){
 if(!/^[a-f0-9]{40}$/.test(revision??'')||model.source_revision!==revision||provenance.source_revision!==revision)throw Error('invalid_archived_source_revision');
 execFileSync('git',['merge-base','--is-ancestor',revision,'HEAD'],{stdio:'pipe'});
 const changed=execFileSync('git',['diff','--name-only',revision,'--'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 if([...changed,...untracked].some(calculationInput))throw Error('archived_calculation_input_changed');
 const frozenBytes=execFileSync('git',['show',revision+':docs/model-freeze.json']);
 if(hash(frozenBytes)!==hash(readFileSync('docs/model-freeze.json')))throw Error('original_model_freeze_changed');
 const frozen=JSON.parse(frozenBytes.toString());
 if(digest(frozen)!==provenance.freeze_digest||frozen.plan_digest!==plan.plan_digest||frozen.subset_digest!==plan.subset_digest||frozen.model_config_digest!==digest(model.model))throw Error('archived_model_freeze_mismatch');
 for(const [path,expected]of Object.entries(frozen.source_files)){
  if(!/^[A-Za-z0-9_./-]+$/.test(path)||path.includes('..')||!/^([a-f0-9]{64})$/.test(expected))throw Error('invalid_frozen_source_path');
  if(hash(readFileSync(path))!==expected||hash(execFileSync('git',['show',revision+':'+path]))!==expected)throw Error('frozen_model_source_changed:'+path);
 }
 for(const [name,version]of Object.entries(frozen.dependency_versions)){
  if(!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)||JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version!==version)throw Error('frozen_dependency_changed');
 }
 return {source_revision:revision,freeze_digest:provenance.freeze_digest,frozen_files:Object.keys(frozen.source_files).length,calculation_inputs_unchanged:true,inference_executed_in_this_job:false};
}
