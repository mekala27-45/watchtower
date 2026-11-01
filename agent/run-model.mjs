import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildUnavailableLedger } from './model-ledger.mjs';
import { TOOL_NAMES } from './tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const writeJson = async (path, value) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value, null, 2) + '\n');
};
export async function probeModel() {
  const dependencies = {};
  for (const name of ['eve', 'ai', 'zod', '@ai-sdk/openai-compatible']) {
    try { import.meta.resolve(name); dependencies[name] = 'resolvable_unverified'; }
    catch { dependencies[name] = 'not_installed'; }
  }
  let endpoint;
  const started = performance.now();
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) endpoint = { state: 'unavailable', status: response.status };
    else {
      const reader = response.body.getReader();
      const parts = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); throw Object.assign(new Error('response_limit'), { code: 'response_limit' }); }
        parts.push(value);
      }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      endpoint = { state: 'reachable', models: (data.models ?? []).slice(0, 20).map(m => ({ name: String(m.name).slice(0, 128), digest: /^[a-f0-9]{64}$/.test(m.digest ?? '') ? m.digest : null })) };
    }
  } catch (error) { endpoint = { state: 'unavailable', safe_error_code: error.code ?? error.cause?.code ?? error.name }; }
  return {
    checked_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, os_release: release(), cpu: cpus()[0]?.model ?? null, memory_bytes: totalmem() },
    dependencies, endpoint: { route: 'fixed_loopback_ollama', ...endpoint, probe_duration_ms: performance.now() - started },
    actual_model_artifact: null, actual_model_artifact_digest: null,
    cpu_placement_evidence: null, gpu_layers: null, inference_attempted: false,
    installed_eve_documentation_read: false, actual_runtime_inventory_verified: false,
    implemented_domain_inventory: TOOL_NAMES, domain_inventory_is_runtime_proof: false,
    adapter_state: 'not_implemented',
    documentation_read_at: '2026-11-01',
    documentation_sources: [
      'https://github.com/vercel/eve/blob/main/docs/concepts/built-in-tools.md',
      'https://github.com/vercel/eve/blob/main/docs/agent-config.md',
      'https://docs.ollama.com/capabilities/tool-calling',
    ],
    conclusion: 'Actual inference and eve runtime tool execution are not done.',
  };
}
export async function main() {
  const plan = await json('docs/evaluation-plan.json');
  const manifest = await json('fixtures/manifest.json');
  const subset = plan.subset_ids ?? manifest.modelSubsetIds;
  if (!Array.isArray(subset)) throw new Error('frozen_model_subset_missing');
  const fixtures = await Promise.all(subset.map(id => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('unsafe_fixture_id');
    return json('fixtures/heldout/' + id + '.json');
  }));
  const probe = await probeModel();
  let revision;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { revision = 'uncommitted'; }
  const ledger = buildUnavailableLedger({ plan, manifest, fixtures, probe, sourceRevision: revision });
  const runId = 'unavailable-' + probe.checked_at.replaceAll(/[^0-9]/g, '') + '-' + createHash('sha256').update(JSON.stringify(probe)).digest('hex').slice(0, 8);
  const provenance = { run_id: runId, plan_digest: ledger.plan_digest, source_revision: revision, method: 'local_agent', actual_inference: false, model: null, artifact_digest: null, cpu_placement: null, generation_settings: plan.generation_budgets ?? { max_turns: 3, max_tool_calls: 4, max_output_tokens: 256, timeout_seconds: 60 }, subset_digest: ledger.subset_digest, ordered_subset_ids: subset, tool_inventory: TOOL_NAMES, actual_runtime_inventory_verified: false, probe_artifact: 'docs/sources/model-probe.json', rows_artifact: 'reports/model/current.json', reason: 'No verified eve adapter or local model runtime is available.' };
  await writeJson('docs/sources/model-probe.json', probe);
  await writeJson('reports/model/runs/' + runId + '.json', { provenance, probe, ledger });
  await writeJson('reports/model/current.json', ledger);
  await writeJson('reports/model/provenance.json', provenance);
  console.log(JSON.stringify({ method: ledger.method, planned: ledger.planned, attempted: ledger.attempted, unexecuted: ledger.unexecuted, quality_available: ledger.quality_available, report: 'reports/model/current.json' }));
  return 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

