import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {scanRepository} from './scan.mjs';
const testFiles=readdirSync('tests').filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'tests/'+x);
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...testFiles],{encoding:'utf8',maxBuffer:32*1024*1024});
mkdirSync('reports/verification',{recursive:true});writeFileSync('reports/verification/tests.tap',(result.stdout||'')+(result.stderr||''));
const count=name=>Number(result.stdout?.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]||0);
const scan=scanRepository();
const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const syntax=[];
for(const file of tracked.filter(f=>f.endsWith('.mjs'))){
 const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0)syntax.push({file,error:'syntax_error'});
}
const prose=[];
for(const file of tracked.filter(f=>f.endsWith('.md'))){
 const text=readFileSync(file,'utf8').replace(/\x60{3}[\s\S]*?\x60{3}/g,'').replace(/\x60[^\x60]*\x60/g,'');
 if(/[^\x09\x0a\x0d\x20-\x7e]/.test(text))prose.push({file,reason:'non_ascii_prose'});
 if(/["']/.test(text))prose.push({file,reason:'quoted_prose'});
}
const record={code_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generated_at:new Date().toISOString(),tests:{total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),exit_code:result.status,evidence:'reports/verification/tests.tap'},syntax:{status:syntax.length?'failed':'passed',failures:syntax},scan,prose:{status:prose.length?'failed':'passed',failures:prose,vocabulary_source:'Inherited Day 7 banned vocabulary unavailable; this gate covers ASCII and quote rules only.'},required_remote_checks:'not_executed',actual_model_gate:'not_executed'};
record.local_checks_passed=result.status===0&&!syntax.length&&scan.status==='passed'&&!prose.length;
writeFileSync('reports/verification/checks.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record,null,2));if(!record.local_checks_passed)process.exitCode=1;
