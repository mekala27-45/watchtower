# Limits

## Supported claims

Watchtower compares typed metadata from identified captured revisions. It reports coverage for a bounded collection procedure and independently grades authored synthetic temporal events. The runtime agent can request three read-or-propose domain tools; host validation controls admission and publication. A stable operation key recovers the same internal publication receipt in the tested database path.

The production architecture requires direct TLS Neon Postgres behind the Vercel container API. The SQLite adapter remains useful for local contract and fault tests. Evidence from one backend or execution path does not establish another path.

## Unsupported claims

The system does not establish complete release history, deletion from an absent list entry, security recommendations, compatibility or upgrade advice. A small authored synthetic subset does not establish general model accuracy. Receipt recovery for one internal transaction does not establish exactly-once delivery to arbitrary external services. A configured schedule does not establish exact timing or any successful scheduled execution.

The API has no browser route for live collection or inference. Public demonstrations use isolated synthetic namespaces. Approved internal publication is not an external business action.

## Method and model boundaries

The deterministic baseline, actual local agent and recorded replay remain separate methods. Model installation, CPU runtime availability and a passing tool contract test are prerequisites, not proof of a completed model evaluation. Only the archived ledger and its provider receipts support actual inference claims. Failed attempts and invalid outputs remain in the frozen denominator.

The current plan uses Qwen3 0.6B with Q4_K_M quantization through the pinned Ollama 0.40.13 runtime. Exact digests and runtime observations are recorded in the model probes and run provenance. The 24-case held-out subset was fixed before evaluation. Budget exhaustion, malformed tool calls and insufficient findings can reduce the result even when the runtime executes correctly.

The recorded actual model attempted all 24 sequences, completed 20 and retained 4 failures. It produced zero supported proposals and missed all 13 expected findings. The useful-model criterion failed. Public deployment does not change those outcomes or supply new inference evidence. The deterministic baseline remains a separate result.

`scripts/verify-report-evidence.mjs --archived` validates an existing run and reports that no inference occurred in that validation job. It rejects missing actual archives, incompatible source changes or incomplete execution evidence. It reports demonstration quality separately from execution validity.

## Unchanged and unknown

A conditional response without matching cache state cannot establish prior content. Treating that response as an empty list would erase the comparison baseline and make a failed collection appear quiet. The collector attempts one unconditional recovery within budget, then retains unknown if recovery fails. The cache and head-preservation tests protect that choice.

A successful bounded run can still cover less than the complete upstream history. The UI preserves latest attempt, last usable evidence and coverage as distinct values.

## Deployment and verification boundaries

The checked-in workflows and deployment scripts are prepared inputs. Public repository creation, a completed Actions run, an observed scheduled run, a Vercel health result, a Pages deployment and its browser flow require their own provider evidence. Live collection executed from the workstation never proves Actions execution.

On November 2 the user explicitly approved the dedicated database credential destinations in Vercel Production and the repository Actions secrets. Both are now configured. On November 3 the [public API](https://watchtower-mekala27-45s-projects.vercel.app) and [Pages build](https://mekala27-45.github.io/watchtower/) identified source revision `05ec1ac5044a84e8f52796fad26275157a9fc01d`. All four GET health, origin and build checks passed in `reports/verification/public-live.json`. API health was ready and production ready with backend Postgres.

The earlier API-hosted interface passed all nine browser checks in `reports/browser/public-api.json` at source revision `58a59b16f1a95021dbcbc19ed59b59292fa5ac24`. It recovered the same Postgres publication receipt, and a separate HTTP client read exactly one receipt. Both themes, mobile layout and accessibility checks passed with matching source and API revisions. The container serves native modules from `apps/site`; that historical run remains separate from the compiled Pages review flow.

The Pages-to-API browser flow subsequently passed all nine checks in `reports/browser/pages.json` at revision `05ec1ac5044a84e8f52796fad26275157a9fc01d`. It exercised visible approval, publication and identical receipt recovery, then confirmed exactly one receipt from a separate HTTP client. Both themes, mobile layout and accessibility checks passed. These observed public results do not imply fresh model inference or complete source coverage.

The [public repository](https://github.com/mekala27-45/watchtower) is verified. Pages dispatch [41666480544](https://github.com/mekala27-45/watchtower/actions/runs/41666480544) and collection dispatch [41666485561](https://github.com/mekala27-45/watchtower/actions/runs/41666485561) succeeded. The independent storage check in `reports/verification/actions-storage.json` passed eight assertions and found eight HTTP attempts, four partial captures and no usable comparison heads. That success proves the bounded runner and persistence path, not complete upstream coverage.

The schedule is enabled at minute 17 every six hours in UTC, as recorded in `reports/verification/github-variables.json`. No scheduled invocation has been observed. Public release completion is separate from repository and workflow availability; inspect the current release evidence before making that claim.

Pinned dependencies, an immutable container image, bundled Fontsource assets and static contrast tests reduce implementation uncertainty. They do not replace hosted container tests, visible keyboard and screen-reader checks, cross-origin browser verification or a public release revision check. Read the current checklist and probe artifacts for the observed status of each boundary.
