# Watchtower results

Local candidate. The required hosted and actual-model core is incomplete.

Portfolio demonstration using public release metadata and authored synthetic evaluation cases. Findings describe captured observations within a declared window. They are not security assessments or upgrade recommendations. Agent proposals, deterministic results, recordings and live observations are labeled separately. Incomplete coverage remains unknown.

## Deterministic baseline

| Metric | Result | Dataset | Evidence |
| --- | --- | --- | --- |
| baseline.full.sequences | 72 sequences | heldout_full | reports/baseline/full.json |
| baseline.full.transitions | 87 transitions | heldout_full | reports/baseline/full.json |
| baseline.full.expected | 42 findings | heldout_full | reports/baseline/full.json |
| baseline.full.emitted | 42 findings | heldout_full | reports/baseline/full.json |
| baseline.full.matched | 42 findings | heldout_full | reports/baseline/full.json |
| baseline.full.duplicates | 0 findings | heldout_full | reports/baseline/full.json |
| baseline.full.unsupported | 0 findings | heldout_full | reports/baseline/full.json |
| baseline.full.precision | 42/42 | heldout_full | reports/baseline/full.json |
| baseline.full.recall | 42/42 | heldout_full | reports/baseline/full.json |
| baseline.full.exact_sequences | 72/72 | heldout_full | reports/baseline/full.json |
| baseline.full.no_op | 21/21 | heldout_full | reports/baseline/full.json |
| baseline.full.unknown | 22/22 | heldout_full | reports/baseline/full.json |
| baseline.subset.sequences | 24 sequences | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.transitions | 28 transitions | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.expected | 13 findings | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.emitted | 13 findings | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.matched | 13 findings | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.duplicates | 0 findings | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.unsupported | 0 findings | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.precision | 13/13 | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.recall | 13/13 | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.exact_sequences | 24/24 | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.no_op | 6/6 | registered_model_subset | reports/baseline/model-subset.json |
| baseline.subset.unknown | 8/8 | registered_model_subset | reports/baseline/model-subset.json |

## Actual local model

| Metric | Result | Dataset | Evidence |
| --- | --- | --- | --- |
| model.planned | 24 sequences | authored_temporal_heldout_subset | reports/model/current.json |
| model.attempted | 0 sequences | authored_temporal_heldout_subset | reports/model/current.json |
| model.completed | 0 sequences | authored_temporal_heldout_subset | reports/model/current.json |
| model.unexecuted | 24 sequences | authored_temporal_heldout_subset | reports/model/current.json |
| model.precision | unavailable | authored_temporal_heldout_subset | reports/model/current.json |
| model.recall | unavailable | authored_temporal_heldout_subset | reports/model/current.json |
| model.supported_proposals | unavailable | authored_temporal_heldout_subset | reports/model/current.json |

Actual inference did not run. Contract-test handler executions are not model executions. No supported actual-model example exists. The registered cases remain visible with unexecuted outcomes.

## Recovery and provenance

See reports/faults for local stored-state assertions and process-death evidence. These checks do not establish hosted Postgres behavior. See reports/verification for local suite, scan and rederivation results. The baseline source revision is preserved in its underlying report; this report revision identifies the renderer inputs.

## Section 20 checklist

1. **not done** Source, dependency and free-host probes are recorded and checked. docs/sources/host-probes.json records registry DNS failure and unverified free-host, direct TLS and source identity checks.

2. **not done** Claim renderer and every required gate pass their three cases. Report, domain, collector and workflow local gates pass; actual-runtime and full browser gates have not executed.

3. **done** Temporal fixtures, independent truth and evaluation plan are frozen. fixtures/manifest.json and the committed docs/evaluation-plan.json identify the frozen corpus and subset.

4. **done** Collector enforces metadata policy, cache scope and honest coverage. Collector and collection-command tests cover policy, exact cache scope, atomic persistence and incomplete-source handling; transport is injected.

5. **not done** Durable source state and fenced leases pass independent checks. SQLite passes separate-connection and process checks; the required Neon Postgres runtime is unimplemented and unverified.

6. **done** Typed detector and verifier pass independent truth and mutation tests. reports/baseline/full.json records independent truth grading and rejection of forged proposals.

7. **not done** Digest-bound review and atomic publication pass stale and retry cases. Local SQLite tests pass stale review and receipt recovery; required hosted Postgres transactions remain unverified.

8. **not done** Functional API is live and verified by browser and separate client. Only in-process request-handler tests ran; no public API URL or browser-to-API evidence exists.

9. **not done** One actual local agent executes only the three permitted tools. reports/model/provenance.json records no actual eve runtime or model-requested handler execution.

10. **not done** Full baseline and declared model subset ran with complete denominators. The baseline ran fully; model rows are retained as unexecuted, so the required actual-model subset did not run.

11. **not done** Actual model quality is reported, including whether supported proposals occurred. reports/model/current.json marks quality unavailable because inference was not attempted; no supported model output is claimed.

12. **not done** Applicable failure cases recover with independent stored-state assertions. reports/faults/matrix.json records local recovery; the required Postgres and actual HTTP recovery checks remain unverified.

13. **not done** Proof-sheet UI, both themes and accessibility checks are complete. Static UI and contrast tests pass; browser rendering, keyboard accessibility, primary fonts and the supplied palette validator are unverified.

14. **not done** Public Pages site completes the visible API review and receipt flow. No public Pages deployment or visible public API flow has been executed.

15. **not done** Governance, notices, source policy, skills and retention checks are complete. Governance and local reference-safe retention exist; collector history pruning and target integration checks remain incomplete.

16. **not done** Actual dispatch succeeded and schedule configuration is reported honestly. The candidate workflow contains a guarded UTC schedule; no actual dispatch or scheduled success is recorded.

17. **not done** Final reports, scans, live checks and clean worktree rederivation pass. Local evidence and rederivation are recorded in reports/verification; required live checks remain unexecuted.

18. **not done** Release commits and tag are verified, with public release state explicit. Local candidate history and tag are prepared and verified; no tag push or public release has occurred.
