# Watchtower verified candidate with public API

Failed collection remains visibly unknown. The application now uses direct TLS Postgres for durable source state, digest-bound review and atomic internal receipt recovery, with an isolated synthetic browser demo.

The deterministic baseline matched 42 of 42 expected findings across 72 held-out sequences. The separate actual local model attempted 24 sequences, completed 20 and retained 4 failures. It produced zero supported proposals. The useful-model criterion did not pass.

The clean checkout passed 156 tests with no skipped cases. Both database fault matrices recovered all 541 applicable cases; the Postgres matrix includes 109 real process terminations. The clean rederivation used a separate database that had no Watchtower tables before migration. The actual model archive was independently regraded, without running inference again.

The original verified source tag is day23-watchtower-verified-candidate. The updated public API evidence package uses local annotated tag day23-watchtower-public-api-candidate. Its commit and full history are recorded in packaged provenance. The archive includes the complete Git bundle and final tag, scan and file-integrity evidence under provenance. The public Vercel PostgreSQL API and its review interface are verified at https://watchtower-mekala27-45s-projects.vercel.app. Nine public browser checks pass, including the same receipt recovered and verified by a separate client. Required GitHub Pages, Actions dispatch, remote tag and public release remain unverified because GitHub authentication and reliable browser targeting are unavailable. Database-secret destination approval is resolved.

Read RESULTS.md for all eighteen completion decisions. Open reports/browser/public-api-demo.gif for the actual screenshot sequence and its adjacent JSON provenance. Exact model and dependency identities remain in the frozen source and run manifests.
