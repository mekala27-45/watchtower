import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../packages/domain/index.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const write=(path,value)=>writeFileSync(resolve(root,path),JSON.stringify(value,null,2)+'\n');
const plan=read('docs/evaluation-plan.json'),development=read('reports/model/development.json'),config=read('docs/model-config.json');
if(development.provenance.prompt_digest!==digest(readFileSync(resolve(root,'agent/instructions.md'),'utf8')))throw new Error('untested_prompt_change');
if(!development.provenance.runtime_inventory_verified||!development.ledger.rows.some(r=>r.handler_executions>0)||!development.ledger.rows.some(r=>r.correct_noop_or_uncertainty))throw new Error('development_runtime_boundary_not_demonstrated');
config.status='frozen';config.adapter='eve-native-ollama-v1';write('docs/model-config.json',config);
const files=['agent/agent.ts','agent/instructions.md','agent/tools.mjs','agent/runtime-boundary.mjs','agent/runtime-bridge.mjs','agent/ollama-native.mjs',
  'agent/actual-ledger.mjs','agent/eve-evaluator.mjs','agent/tools/list_changes.ts','agent/tools/inspect_snapshot.ts','agent/tools/propose_finding.ts',
  'packages/domain/index.mjs','packages/domain/grader.mjs','docs/evaluation-plan.json','docs/model-config.json'];
const source_files=Object.fromEntries(files.map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')]));
const dependency_versions=Object.fromEntries(['eve','ai','@ai-sdk/provider'].map(name=>[name,read('node_modules/'+name+'/package.json').version]));
write('docs/model-freeze.json',{schema:'watchtower-model-freeze-v1',frozen_at:new Date().toISOString(),plan_digest:plan.plan_digest,subset_digest:plan.subset_digest,
  model_config_digest:digest(config),source_files,dependency_versions,development_run:development.provenance.run_id,
  development_result:{attempted:development.ledger.attempted,handler_executions:development.ledger.rows.reduce((n,r)=>n+r.handler_executions,0),
    supported_proposals:development.ledger.summary.supported_proposals,correct_noop_or_uncertainty:development.ledger.summary.correct_noop_or_uncertainty},
  limitation:'Development demonstrates a real handler result and a correct no-op. No supported factual proposal was produced; this weakness is preserved without tuning on heldout data.',
  invariant:'No model, adapter, prompt, schema, generation budget or subset changes after this snapshot. Commit these files before the heldout command.'});
console.log(JSON.stringify({status:'frozen',files:files.length,development_run:development.provenance.run_id,model:config.model,artifact_digest:config.artifact_digest}));
