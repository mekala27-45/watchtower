import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {digest} from '../packages/reports/index.mjs';

const root=process.cwd(),revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const suffix=new Date().toISOString().replace(/[^0-9]/g,'');
const target=resolve(dirname(root),basename(root)+'-rederive-'+revision.slice(0,10)+'-'+suffix);
const relation=relative(dirname(root),target);
if(!relation||relation.startsWith('..')||isAbsolute(relation)||existsSync(target))throw Error('unsafe_worktree_path');
execFileSync('git',['worktree','add','--detach',target,revision],{stdio:'pipe'});
const initial=execFileSync('git',['status','--porcelain'],{cwd:target,encoding:'utf8'}).trim();
if(initial)throw Error('worktree_not_clean');
mkdirSync(resolve(target,'reports/verification'),{recursive:true});
const commands=[],comparisons=[],preserved=[];
const childEnv={...process.env,WATCHTOWER_BROWSER_LABEL:'rederive',WATCHTOWER_BROWSER_POSTGRES:'0'};
delete childEnv.WATCHTOWER_BROWSER_URL;
delete childEnv.WATCHTOWER_PUBLIC_API_ORIGIN;
delete childEnv.WATCHTOWER_RUNTIME_DIR;
if(childEnv.DATABASE_URL&&!childEnv.WATCHTOWER_TEST_DATABASE_URL)childEnv.WATCHTOWER_TEST_DATABASE_URL=childEnv.DATABASE_URL;
const report={revision,worktree:target,started_clean:true,commands,comparisons,preserved_artifacts:preserved,
 fresh_database_state:'SQLite tests use fresh temporary or in-memory stores. PostgreSQL tests, when configured, use fresh random test namespaces and independent connections. No original application database or model session state is copied.',
 actual_model_executed:false,actual_model_evidence_regraded:false,public_checks_executed:false,
 postgres_tests_configured:!!childEnv.WATCHTOWER_TEST_DATABASE_URL,started_at:new Date().toISOString()};
function run(script,args=[],allowed=[0],label=script.split('/').pop()){
 const result=spawnSync(process.execPath,[script,...args],{cwd:target,encoding:'utf8',env:childEnv,maxBuffer:64*1024*1024,windowsHide:true});
 const log='reports/verification/rederive-'+label+'.log';
 writeFileSync(resolve(target,log),(result.stdout||'')+(result.stderr||''));
 commands.push({script,args,exit_code:result.status,allowed_exit_codes:allowed,log});
 if(!allowed.includes(result.status))throw Error('rederive_failed:'+label);
}
function preserve(path,label=basename(path)){
 if(!existsSync(resolve(target,path)))return;
 const destination='reports/verification/rederived-artifacts/'+label;mkdirSync(resolve(root,dirname(destination)),{recursive:true});
 copyFileSync(resolve(target,path),resolve(root,destination));preserved.push({source:path,path:destination});
}
const json=(base,path)=>JSON.parse(readFileSync(resolve(base,path),'utf8'));
try{
 const npmCli=process.env.npm_execpath??resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 if(!existsSync(npmCli))throw Error('npm_cli_not_found');
 run(npmCli,['ci','--ignore-scripts','--no-audit','--no-fund'],[0],'npm-ci');
 run('scripts/verify-report-evidence.mjs',['--archived']);
 report.actual_model_evidence_regraded=true;
 const baselinePaths=['reports/baseline/full.json','reports/baseline/model-subset.json'];
 const archivedBaseline=new Map(baselinePaths.map(path=>[path,readFileSync(resolve(target,path))]));
 const archivedModelDigest=digest(json(target,'reports/model/current.json'));
 run('scripts/generate-fixtures.mjs');
 run('scripts/evaluate.mjs');
 for(const path of baselinePaths){
  const expected=json(root,path).stable_digest,actual=json(target,path).stable_digest;
  comparisons.push({path,expected,actual,match:expected===actual});
  writeFileSync(resolve(target,'reports/verification/rederived-'+basename(path)),readFileSync(resolve(target,path)));
 }
 const oldFixture=json(root,'fixtures/manifest.json'),newFixture=json(target,'fixtures/manifest.json');
 comparisons.push({path:'fixtures/manifest.json',expected:digest(oldFixture),actual:digest(newFixture),match:digest(oldFixture)===digest(newFixture)});
 run('scripts/check.mjs');
 run('scripts/fault-matrix.mjs');
 if(childEnv.WATCHTOWER_TEST_DATABASE_URL)run('scripts/fault-matrix-postgres.mjs');
 run('node_modules/typescript/bin/tsc',[],[0],'typecheck');
 run('scripts/build-site.mjs');
 run('tests/browser-flow.mjs');
 const faultSummary=r=>({planned:r.planned,applicable:r.applicable,exercised:r.exercised,recovered:r.recovered,failed:r.failed,notApplicable:r.notApplicable,rows:r.rows.map(x=>({fixtureId:x.fixtureId,overlay:x.overlay,applicable:x.applicable,status:x.status}))});
 const oldFault=faultSummary(json(root,'reports/faults/matrix.json')),newFault=faultSummary(json(target,'reports/faults/matrix.json'));
 comparisons.push({path:'reports/faults/matrix.json stable outcomes',expected:digest(oldFault),actual:digest(newFault),match:digest(oldFault)===digest(newFault)});
 if(childEnv.WATCHTOWER_TEST_DATABASE_URL){
  const oldPostgres=faultSummary(json(root,'reports/faults/postgres-matrix.json')),newPostgres=faultSummary(json(target,'reports/faults/postgres-matrix.json'));
  comparisons.push({path:'reports/faults/postgres-matrix.json stable outcomes',expected:digest(oldPostgres),actual:digest(newPostgres),match:digest(oldPostgres)===digest(newPostgres)});
 }
 comparisons.push({path:'reports/model/current.json preserved actual inference archive',expected:archivedModelDigest,actual:digest(json(target,'reports/model/current.json')),match:archivedModelDigest===digest(json(target,'reports/model/current.json'))});
 // Re-derived deterministic outputs remain above. Restore original execution metadata so
 // the combined report never pretends the archived model ran at a different revision.
 for(const [path,contents]of archivedBaseline)writeFileSync(resolve(target,path),contents);
 run('scripts/render-reports.mjs',['--archived']);
 report.local_rederivation_passed=comparisons.every(c=>c.match);
}catch(error){report.local_rederivation_passed=false;report.error=error.message;}
for(const command of commands)preserve(command.log);
for(const path of ['reports/verification/checks.json','reports/verification/tests.tap','reports/verification/rederived-full.json','reports/verification/rederived-model-subset.json','reports/faults/matrix.json','reports/faults/postgres-matrix.json','reports/browser/rederive.json'])preserve(path,path.replaceAll('/','-'));
report.finished_at=new Date().toISOString();
writeFileSync(resolve(root,'reports/verification/rederive.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(!report.local_rederivation_passed)process.exitCode=1;
