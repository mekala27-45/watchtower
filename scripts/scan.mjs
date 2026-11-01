import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
export function scanText(text) {
 const rules=[
  ['private_key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github_token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['provider_key',/\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['database_credential',/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i],
  ['release_body_in_public',/"body"\s*:\s*"(?!Authored|Synthetic)[^"]{400,}/]
 ];
 return rules.filter(([,regex])=>regex.test(text)).map(([id])=>id);
}
export function scanRepository() {
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 const failures=[];
 for(const p of paths) {
  if(/\.(png|gif|jpg|zip|bundle|woff2?)$/.test(p)) continue;
  const hits=scanText(readFileSync(p,'utf8'));
  if(hits.length) failures.push({path:p,rules:hits});
 }
 const commits=execFileSync('git',['rev-list','--all'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 for(const sha of commits) {
  const diff=execFileSync('git',['show','--format=','--no-ext-diff',sha],{encoding:'utf8',maxBuffer:32*1024*1024});
  const hits=scanText(diff); if(hits.length) failures.push({commit:sha,rules:hits});
 }
 if(!paths.length||!commits.length) throw Error('empty_scan');
 return {status:failures.length?'failed':'passed',files:paths.length,commits:commits.length,failures,scope:'pattern-based secret and release-body scan; not a complete security audit'};
}
if(process.argv[1]?.endsWith('scan.mjs')) {
 const result=scanRepository(); console.log(JSON.stringify(result,null,2)); if(result.status!=='passed') process.exitCode=1;
}
