import { createHash } from 'node:crypto';

export function buildUnavailableLedger({ plan, manifest, fixtures, probe, sourceRevision }) {
  if (!plan || !manifest || !Array.isArray(fixtures) || !probe ||
      !/^[a-f0-9]{64}$/.test(plan.plan_digest ?? '')) throw new Error('invalid_model_plan');
  const subset = plan.subset_ids ?? manifest.modelSubsetIds;
  if (!Array.isArray(subset) || subset.length !== 24 || new Set(subset).size !== 24 ||
      JSON.stringify([...subset].sort()) !== JSON.stringify([...(manifest.modelSubsetIds ?? [])].sort())) throw new Error('invalid_model_subset');
  const byId = new Map(fixtures.map(f => [f.id, f]));
  const families = new Map();
  const rows = subset.map(id => {
    const fixture = byId.get(id);
    if (!fixture || fixture.split !== 'heldout' || typeof fixture.family !== 'string') throw new Error('missing_model_fixture');
    families.set(fixture.family, (families.get(fixture.family) ?? 0) + 1);
    return {
      fixture_id: id, family: fixture.family, method: 'local_agent',
      status: 'unexecuted', inference_attempted: false,
      reason: 'actual_eve_adapter_unavailable',
      model_request_count: 0, model_requested_tool_calls: 0, handler_executions: 0,
      proposed_findings: [], elapsed_ms: null, generated_tokens: null,
      precision: null, recall: null, supported_proposals: null,
      correct_noop_or_uncertainty: null, quality_available: false,
    };
  });
  if (families.size !== 12 || [...families.values()].some(n => n !== 2)) throw new Error('unbalanced_model_subset');
  const subsetDigest = createHash('sha256').update(JSON.stringify(subset)).digest('hex');
  return {
    schema_version: 'watchtower-model-ledger-v1',
    method: 'local_agent', execution_mode: 'actual_inference_unavailable',
    namespace: 'evaluation', dataset: 'authored_temporal_heldout_subset',
    plan_digest: plan.plan_digest, source_revision: sourceRevision,
    subset_digest: subsetDigest, fixture_digest: manifest.fixture_digest ?? null,
    subset_ids: subset, probe_artifact: 'docs/sources/model-probe.json',
    baseline_comparison_artifact: 'reports/baseline/model-subset.json',
    complete_evaluation: false, planned: rows.length, attempted: 0, completed: 0,
    unexecuted: rows.length, quality_available: false,
    model_metrics: {
      precision: { value: null, unit: 'ratio', numerator: null, denominator: null, state: 'unavailable' },
      recall: { value: null, unit: 'ratio', numerator: null, denominator: null, state: 'unavailable' },
      supported_proposals: { value: null, unit: 'count', state: 'unavailable' },
    },
    demonstration_criteria: {
      all_cases_attempted: false, supported_proposal_observed: null,
      correct_noop_or_uncertainty_observed: null, unsupported_published_fact_observed: null,
      passed: false,
    },
    rows,
    limitation: 'No actual local model inference or eve tool execution occurred. Contract tests are separate and supply no model quality evidence.',
  };
}

