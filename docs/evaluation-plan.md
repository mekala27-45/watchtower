# Frozen evaluation plan

The authored oracle is independent of detector and verifier code. Each family has twelve separately named temporal templates. The first six templates belong to development and the remaining six belong to held-out. Lineages never cross splits. Variants exercise different metadata, transport or temporal boundaries, not random paraphrases.

The canonical plan and its digest live in docs/evaluation-plan.json. The fixture manifest declares all sequence identities and the balanced model subset. The subset uses the registered stable hash rank with seed watchtower-day23-v1. Freeze this plan in Git before held-out execution.

Run node scripts/generate-fixtures.mjs twice in fresh processes and compare fixtures/manifest.json. Run node scripts/evaluate.mjs only after the plan is committed. Full deterministic results and matched model-subset baseline results remain separate tables. Actual model attempts and unexecuted rows belong only to the model report. A missing model process never produces a model score.

The sequence is the sampling unit. Exact fact identity includes namespace, source, release, before and after evidence, predicate and field. Duplicate emissions cannot increase recall. A denominator of zero is not applicable. Unknown coverage is never a correct negative. The report makes no inferential significance claim.

Fault applicability is registered in the JSON plan before execution. All collection and lease overlays apply to every held-out sequence. Publication loss applies only when the authored sequence has at least one expected finding. Every excluded combination has that specific reason.

The deterministic harness evaluates admitted authored observations. Controlled HTTP collector checks are a separate suite. Those unit checks do not count as live collection, model inference, human review or public deployment. Execution receipts explicitly name which stage ran.
