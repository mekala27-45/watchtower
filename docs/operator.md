# Operator procedure

Watchtower has three separate runtime surfaces: the static GitHub Pages application, the Vercel container API, and an administrator collection command that writes to direct TLS Postgres on Neon. The browser can create isolated demonstration sessions and use their capability. It cannot collect sources, change the watchlist or invoke the model.

## Install and verify

Use Node 24.19.0 and run the following from the repository root.

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node scripts/check.mjs
npm exec --offline -- tsc --noEmit
node scripts/verify-report-evidence.mjs --archived
node scripts/build-site.mjs
```

The archived evidence check requires the recorded source revision to remain an ancestor with no relevant source changes. It verifies every registered model attempt, provider receipts, CPU placement and frozen fixture identity. It does not run inference, and it does not require every model prediction to be correct. A failed case remains a failed case in the report. The CI workflow uses this gate and labels the work as archive validation.

Fresh baseline evaluation uses `npm run evaluate`. Fresh actual inference uses `npm run eval:model` with the pinned local CPU model runtime and the frozen evaluation plan. Render the report only after both methods have complete provenance for the same source revision. Do not execute these commands just to replace missing actual results with baseline values. Source changes after a real run require a new run; a later documentation-only commit can retain the verified archive.

## Local API

Run `deploy/Run-Local.ps1` to start the explicitly labeled SQLite candidate on loopback. In another terminal run `deploy/Verify-Local.ps1`. The verifier creates an isolated synthetic demonstration session, prepares and approves its digest, publishes once, then retries the same operation key and checks receipt recovery. The capability is not printed.

To use the actual Postgres adapter on loopback, provide the approved direct database connection in the process environment and run `deploy/Run-Local.ps1 -Backend postgres`. The direct hostname must not be a pooled hostname. The adapter verifies the TLS certificate and uses channel binding. Use `-Migrate` only when applying the checked-in schema to the intended Watchtower database. Verify with `deploy/Verify-Local.ps1 -Backend postgres`.

A successful loopback test against Neon proves that client, adapter and database path. It does not prove the Vercel container, public origin, Pages interface or GitHub runner.

## Vercel API and Pages

`Dockerfile.vercel` selects the Vercel container runtime and pins the Node image manifest recorded in `reports/probes/container-image.json`. It installs the lockfile graph, binds to `0.0.0.0` on `PORT=80`, and requires Postgres in production. `deploy/Prepare-Deployment.ps1` verifies the runtime, image and archive inputs without uploading credentials or creating a deployment.

The dedicated project is `watchtower`, with project ID `prj_lYRZi3drj3O1KVLqx98pdpBEPAZL` on the existing Hobby team. On November 2 the user explicitly approved the dedicated database credential destinations in Vercel Production and the intended GitHub repository Actions secrets. The Vercel Production secret was stored successfully. Keep migrations as an operator action; leave `WATCHTOWER_MIGRATE` unset during ordinary API requests. Keep `BUILD_REVISION` tied to the deployed source and `WATCHTOWER_ORIGINS` tied to the intended Pages origin.

Deployment `dpl_4q5w3qndov9DbwxBeriS5JZz4q42` reached READY. The public API is [Watchtower API](https://watchtower-mekala27-45s-projects.vercel.app). The three GET checks in `reports/verification/public-live.json` passed: health returned HTTP 200 with Postgres readiness and production readiness, the intended Pages origin received the exact allowed origin header, and an untrusted origin received HTTP 403. The observed source revision is `58a59b16f1a95021dbcbc19ed59b59292fa5ac24`.

The public API also serves the native browser modules under `apps/site`. All nine browser checks passed against that URL in `reports/browser/public-api.json`, with matching source and API revisions. The review flow approved, published and recovered the same Postgres receipt; a separate HTTP client read exactly one receipt. Both themes, narrow layout, keyboard focus, reduced motion and screen reader labels passed. This is the API-hosted interface, not the compiled Pages application. GitHub Pages remains absent.

After deployment, check the public `/health` response, backend, revision, CORS behavior and synthetic review flow. Configure GitHub Pages to use Actions and set repository variable `WATCHTOWER_PUBLIC_API_ORIGIN` to the plain verified HTTPS API origin. It is public configuration, never a database URL or capability. Dispatch `pages.yml` once, inspect the completed provider run and open the resulting Pages URL. Its `build.json` must identify the expected revision and API origin. Only then enable automatic Pages pushes with `WATCHTOWER_PAGES_ENABLED=true`.

The intended repository `mekala27-45/watchtower` has not been created. GitHub CLI reports no authenticated hosts. The requested Chrome profile displayed Gmail for `mekalaajayk@gmail.com`, but the minimized window was unstable and GitHub ownership was not verified. TinyFish has no recorded signed-in profile for GitHub. Repository setup, Actions secrets, Pages, dispatch and public release remain blocked on usable authenticated GitHub access. The approved database secret must still stay out of Pages and public artifacts.

The static application bundles the licensed Latin font assets. The build retains license texts and font provenance under `licenses/`. A successful static build alone does not establish a visible browser flow or accessibility.

## Bounded collection

The administrator command is `node scripts/collect-postgres.mjs --run-key OPERATOR_RUN_KEY`. Use a unique bounded key containing only letters, digits, underscores or hyphens. The fixed watchlist and verified numeric repository identities come from `config/watchlist.json`. The collector admits no arbitrary repository or URL input. It has a shared maximum of 24 HTTP attempts, a 45-second run deadline, two list pages per source and at most four item rechecks. Requests occur outside short database transactions.

The Actions workflow uses `gha-RUN_ID-RUN_ATTEMPT` as the key and scopes the `DATABASE_URL` secret to the collection step. No database credential is exposed to the static build or CI pull-request job. A separate provider artifact records the event, commit, run URL and collection step outcome. That record intentionally leaves final workflow success unverified until the completed run and persisted rows are checked independently.

The workflow permits manual dispatch while recurring collection remains disabled. No actual Actions dispatch has run. Keep `WATCHTOWER_COLLECTION_ENABLED` unset or false until an actual manual Actions run and its database effects have passed verification. The candidate UTC schedule is at minute 17 every six hours. A manual dispatch does not establish scheduled execution, and GitHub does not guarantee exact start times. Local live collection retains local provenance and never counts as an Actions dispatch.

## Recovery and retention

If a collection lease expires, acquire a new generation and preserve the old attempt. The generation and expected-head fence must reject stale writes. A rate limit, outage or incomplete list does not erase usable prior evidence. Respect the recorded retry time rather than forcing repeated source requests.

If a publication response is lost, retry its original operation key and briefing digest. If dependencies changed before the effect committed, prepare and review a new revision. Do not rewrite existing receipts or evidence. Retention must preserve current heads, referenced evidence, approvals, receipts and receipt-backed recovery dependencies while enforcing the configured history budgets.

Completion evidence is recorded in the generated reports and the section 20 checklist. Never promote planned configuration, a local command or an account listing into a hosted success.
