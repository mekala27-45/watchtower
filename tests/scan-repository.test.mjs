import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scanner=fileURLToPath(new URL('../scripts/scan.mjs',import.meta.url));
function withRepository(run){
 const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'watchtower-scan-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init','--quiet');
  git('config','user.name','Watchtower Scan Test');
  git('config','user.email','watchtower-test@example.invalid');
  git('config','commit.gpgsign','false');
  run({root,git,scan:()=>spawnSync(process.execPath,[scanner],{cwd:root,encoding:'utf8'})});
 }finally{
  const within=relative(parent,resolve(root));
  assert.ok(within&&!within.startsWith('..')&&!isAbsolute(within),'temporary repository stays inside the temporary directory');
  rmSync(root,{recursive:true,force:true});
 }
}
test('repository scan clean gate admits committed inert placeholders',()=>withRepository(({root,git,scan})=>{
 writeFileSync(join(root,'settings.txt'),'DATABASE_URL=SET_IN_PLATFORM\n');
 git('add','settings.txt');git('commit','--quiet','-m','Add inert configuration');
 const result=scan();assert.equal(result.status,0);
 const report=JSON.parse(result.stdout);
 assert.equal(report.status,'passed');assert.equal(report.files,1);assert.equal(report.commits,1);
 assert.deepEqual(report.failures,[]);
}));
test('repository scan violation gate detects a removed synthetic credential in commit history',()=>withRepository(({root,git,scan})=>{
 writeFileSync(join(root,'settings.txt'),'DATABASE_URL=SET_IN_PLATFORM\n');
 git('add','settings.txt');git('commit','--quiet','-m','Add inert configuration');
 writeFileSync(join(root,'synthetic.txt'),['gh','p_','a'.repeat(36)].join('')+'\n');
 git('add','synthetic.txt');git('commit','--quiet','-m','Add synthetic scan fixture');
 const introduced=git('rev-parse','HEAD');
 git('rm','--quiet','synthetic.txt');git('commit','--quiet','-m','Remove synthetic scan fixture');
 const result=scan();assert.equal(result.status,1);
 const report=JSON.parse(result.stdout);
 assert.equal(report.status,'failed');assert.equal(report.files,1);assert.equal(report.commits,3);
 assert.ok(report.failures.some(row=>row.commit===introduced&&row.rules.includes('github_token')));
 assert.equal(report.failures.some(row=>row.path),false,'the current tree is clean but history still fails');
}));
test('repository scan empty gate refuses a repository without files or commits',()=>withRepository(({scan})=>{
 const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/empty_scan/);
 assert.equal(result.stdout.trim(),'');
}));
