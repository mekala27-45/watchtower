import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {digest} from '../packages/reports/index.mjs';
const root=process.cwd();
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const target=resolve(dirname(root),basename(root)+'-rederive-'+revision.slice(0,10));
if(!target.startsWith(resolve(dirname(root))+'\\')&&!target.startsWith(resolve(dirname(root))+'/'))throw Error('unsafe_worktree_path');
if(existsSync(target))throw Error('worktree_already_exists');
execFileSync('git',['worktree','add','--detach',target,revision],{stdio:'pipe'});
const initial=execFileSync('git',['status','--porcelain'],{cwd:target,encoding:'utf8'}).trim();
if(initial)throw Error('worktree_not_clean');
const commands=[];
function run(script,allowed=[0]){
 const result=spawnSync(process.execPath,[script],{cwd:target,encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
 commands.push({script,exit_code:result.status,allowed_exit_codes:allowed});
 writeFileSync(resolve(target,'reports/verification/rederive-'+script.split('/').pop()+'.log'),(result.stdout||'')+(result.stderr||''));
 if(!allowed.includes(result.status))throw Error('rederive_failed:'+script);
}
mkdirSync(resolve(target,'reports/verification'),{recursive:true});
run('scripts/generate-fixtures.mjs');
run('scripts/evaluate.mjs');
run('agent/run-model.mjs',[2]);
run('scripts/check.mjs');
run('scripts/fault-matrix.mjs');
run('scripts/render-reports.mjs');
const json=(base,path)=>JSON.parse(readFileSync(resolve(base,path),'utf8'));
const comparisons=[];
for(const path of ['reports/baseline/full.json','reports/baseline/model-subset.json']){
 const expected=json(root,path).stable_digest,actual=json(target,path).stable_digest;
 comparisons.push({path,expected,actual,match:expected===actual});
}
const oldFixture=json(root,'fixtures/manifest.json'),newFixture=json(target,'fixtures/manifest.json');
comparisons.push({path:'fixtures/manifest.json',expected:digest(oldFixture),actual:digest(newFixture),match:digest(oldFixture)===digest(newFixture)});
const faultSummary=r=>({planned:r.planned,applicable:r.applicable,exercised:r.exercised,recovered:r.recovered,failed:r.failed,notApplicable:r.notApplicable,rows:r.rows.map(x=>({fixtureId:x.fixtureId,overlay:x.overlay,applicable:x.applicable,status:x.status}))});
const oldFault=faultSummary(json(root,'reports/faults/matrix.json')),newFault=faultSummary(json(target,'reports/faults/matrix.json'));
comparisons.push({path:'reports/faults/matrix.json stable outcomes',expected:digest(oldFault),actual:digest(newFault),match:digest(oldFault)===digest(newFault)});
const modelRows=r=>r.rows.map(x=>({fixture_id:x.fixture_id,status:x.status,inference_attempted:x.inference_attempted}));
comparisons.push({path:'reports/model/current.json unexecuted rows',match:digest(modelRows(json(root,'reports/model/current.json')))===digest(modelRows(json(target,'reports/model/current.json')))});
const report={revision,worktree:target,started_clean:!initial,fresh_database_state:'Tests and fault harness create independent temporary databases, no original state copied.',commands,comparisons,local_rederivation_passed:comparisons.every(c=>c.match),actual_model_executed:false,public_checks_executed:false,generated_at:new Date().toISOString()};
writeFileSync(resolve(root,'reports/verification/rederive.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(!report.local_rederivation_passed)process.exitCode=1;
