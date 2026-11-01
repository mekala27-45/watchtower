# Local candidate release

Watchtower implements and tests a bounded deterministic workflow, local durable review, an isolated synthetic UI, source-policy contracts and honest missing-model records.

This is an incomplete candidate. The actual eve adapter, CPU model execution, hosted Postgres runtime, Vercel API, Pages flow, actual dispatch and public release remain unexecuted. See RESULTS.md for every section 20 status and evidence.

The local annotated tag is day23-watchtower-local-candidate. It is not pushed. The validated source and artifact digests are recorded in reports/release-artifacts.json. The clean reproduction result is reports/verification/rederive.json. No runtime outbound action exists.

Start the local app with deploy/Run-Local.ps1. Required target completion begins with the network and dependency probes in deploy/Prepare-Deployment.ps1 and docs/operator.md. Do not publish the SQLite adapter on an ephemeral host.
